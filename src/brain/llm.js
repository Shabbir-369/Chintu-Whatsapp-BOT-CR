/**
 * src/brain/llm.js
 * Gemini API client. One call per reply, JSON output, retries, budget. §15.1.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';
import { config } from '../config.js';
import { getLogger } from '../logger.js';
import { incrementUsage, getUsageToday } from '../db/repos/timetable.js';
import { sleep } from '../util/time.js';

const log = getLogger('brain/llm');

const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);

// thinkingBudget:0 only works on gemini-2.5 models
const modelSupportsThinking = config.GEMINI_MODEL.startsWith('gemini-2.5');
const thinkingConfig = modelSupportsThinking ? { thinkingBudget: 0 } : undefined;

// ─── Output Schema (§15.3) ────────────────────────────────────────

const replySchema = z.object({
  reply_parts: z.array(z.string()).max(2).default([]),
  reaction: z.string().nullable().default(null),
  quote: z.boolean().default(false),
  tone_used: z.string().default('savage'),
  flags: z.object({
    attempt_to_extract: z.boolean().default(false),
    attack_on_owner: z.boolean().default(false),
    serious_distress: z.boolean().default(false),
    bunk_plan: z.boolean().default(false),
    wants_dm_topic: z.boolean().default(false),
  }).default({}),
  memory_ops: z.array(z.object({
    type: z.string(),
    person: z.string().optional(),
    text: z.string(),
    importance: z.number().min(1).max(5).default(3),
    confidence: z.number().min(0).max(1).default(1.0),
  })).default([]),
  name_hint: z.object({
    person: z.string(),
    name: z.string(),
    evidence: z.string().optional(),
  }).nullable().default(null),
});

const intentSchema = z.object({
  intent: z.string(),
  entities: z.record(z.any()).default({}),
  confidence: z.number().min(0).max(1).default(0.5),
});

/**
 * Check if AI budget is exhausted.
 */
export async function isBudgetExhausted() {
  try {
    const used = await getUsageToday('ai_calls');
    return used >= config.DAILY_AI_CAP;
  } catch {
    return false;
  }
}

/**
 * Check if owner AI budget is available (always reserve 40 calls for owner).
 */
export async function isOwnerBudgetAvailable() {
  try {
    const used = await getUsageToday('ai_calls');
    return used < config.DAILY_AI_CAP - 40;
  } catch {
    return true;
  }
}

/**
 * Make the reply model call.
 * @param {string} systemPrompt
 * @param {object[]} conversationHistory – [{ role, parts }]
 * @param {string} userMessage
 * @param {boolean} isOwner
 * @returns {Promise<object>} Validated reply schema
 */
export async function generateReply(systemPrompt, conversationHistory, userMessage, isOwner = false) {
  const generationConfig = {
    responseMimeType: 'application/json',
    maxOutputTokens: 500,
    temperature: 1.0,
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };
  const model = genAI.getGenerativeModel({
    model: config.GEMINI_MODEL,
    generationConfig,
    systemInstruction: systemPrompt,
  });

  const safeUserMessage = String(userMessage ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const contents = [
    ...conversationHistory.slice(-6), // last 6 turns for context
    {
      role: 'user',
      parts: [{ text: `<message>${safeUserMessage}</message>` }],
    },
  ];

  let attempt = 0;
  while (attempt < 2) {
    try {
      const result = await Promise.race([
        model.generateContent({ contents }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('LLM timeout')), 30000)),
      ]);

      const text = result.response.text();
      const parsed = JSON.parse(text);
      const validated = replySchema.parse(parsed);

      // Track usage
      await incrementUsage('ai_calls').catch(() => {});

      return validated;
    } catch (err) {
      attempt++;
      if (attempt >= 2) {
        log.error({ err }, 'LLM call failed after 2 attempts');
        throw err;
      }
      log.warn({ err, attempt }, 'LLM call failed, retrying...');
      await sleep(1500);
    }
  }
}

/**
 * Parse owner intent using a separate lightweight call.
 * @param {string} systemPrompt
 * @param {string} messageText
 * @returns {Promise<object>} Validated intent schema
 */
export async function parseOwnerIntent(systemPrompt, messageText) {
  const generationConfig = {
    responseMimeType: 'application/json',
    maxOutputTokens: 300,
    temperature: 0.1,
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };
  const model = genAI.getGenerativeModel({
    model: config.GEMINI_MODEL,
    generationConfig,
    systemInstruction: systemPrompt,
  });

  let attempt = 0;
  while (attempt < 2) {
    try {
      const result = await model.generateContent(messageText);
      const text = result.response.text();
      const parsed = JSON.parse(text);
      await incrementUsage('ai_calls').catch(() => {});
      return intentSchema.parse(parsed);
    } catch (err) {
      attempt++;
      if (attempt >= 2) throw err;
      await sleep(1500);
    }
  }
}

/**
 * Nightly consolidation model call.
 * @param {string} prompt
 * @returns {Promise<object>}
 */
export async function consolidateMemory(prompt) {
  const generationConfig = {
    responseMimeType: 'application/json',
    maxOutputTokens: 600,
    temperature: 0.7,
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };
  const model = genAI.getGenerativeModel({
    model: config.GEMINI_MODEL,
    generationConfig,
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  await incrementUsage('ai_calls').catch(() => {});
  return JSON.parse(text);
}
