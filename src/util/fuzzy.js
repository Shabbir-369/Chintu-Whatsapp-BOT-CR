/**
 * src/util/fuzzy.js
 * Fuzzy group/person matching as specified in §11.2.
 * Scoring: exact=1.0, contains=0.9, trigram similarity otherwise.
 * Auto-accepts when top score >= 0.85 AND gap to second >= 0.15.
 */
import { normalise, similarity } from './text.js';

/**
 * Score a query against a list of named items.
 * @param {string} query
 * @param {Array<{name: string, [key: string]: any}>} items
 * @returns {Array<{item, score}>} Sorted descending by score
 */
export function scoreAll(query, items) {
  const nq = normalise(query);
  return items
    .map(item => {
      const n = normalise(item.name || item.subject || item.display_name || '');
      let score = 0;
      if (n === nq) score = 1.0;
      else if (n.includes(nq) || nq.includes(n)) score = 0.9;
      else score = similarity(nq, n);
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Find the best match for a query among items.
 * Returns: { match, ambiguous, candidates }
 *   - match: the item if unambiguous, null otherwise
 *   - ambiguous: true if multiple items are plausible
 *   - candidates: top items to show in disambiguation
 *
 * @param {string} query
 * @param {Array<{name: string}>} items
 * @param {object} [opts]
 * @param {number} [opts.threshold=0.85] – minimum score to auto-accept
 * @param {number} [opts.gap=0.15] – minimum gap between top two
 * @param {number} [opts.maxCandidates=5]
 * @returns {{ match: object|null, ambiguous: boolean, candidates: Array }}
 */
export function fuzzyMatch(query, items, opts = {}) {
  const { threshold = 0.85, gap = 0.15, maxCandidates = 5 } = opts;
  if (!query || !items.length) return { match: null, ambiguous: false, candidates: [] };

  const scored = scoreAll(query, items);
  const top = scored[0];
  const second = scored[1];

  // Check if any candidate is plausible (score > 0.4)
  const plausible = scored.filter(s => s.score > 0.4).slice(0, maxCandidates);

  if (top.score >= threshold) {
    const topGap = second ? top.score - second.score : 1;
    if (topGap >= gap || !second || second.score < 0.4) {
      return { match: top.item, ambiguous: false, candidates: [top] };
    }
  }

  // Ambiguous or no good match
  if (plausible.length === 0) {
    // Return top 5 anyway
    return { match: null, ambiguous: false, candidates: scored.slice(0, maxCandidates) };
  }
  if (plausible.length === 1) {
    return { match: plausible[0].item, ambiguous: false, candidates: plausible };
  }
  return { match: null, ambiguous: true, candidates: plausible };
}

/**
 * Format a disambiguation list for sending to the owner.
 * @param {Array<{item, score}>} candidates
 * @param {Function} labelFn – extracts a label string from item
 * @returns {string}
 */
export function formatDisambig(candidates, labelFn) {
  return candidates
    .map((c, i) => `${i + 1}. ${labelFn(c.item)}`)
    .join('\n');
}

/**
 * Resolve the owner's choice from a disambiguation reply.
 * Accepts: a number ("2"), member count ("jisme 68 hain"), or more of the name.
 * @param {string} reply – owner's answer
 * @param {Array<{item, score}>} candidates
 * @param {Function} [labelFn] – extracts label from item
 * @returns {object|null} The chosen item or null
 */
export function resolveDisambigChoice(reply, candidates, labelFn = (c) => c.item.subject || c.item.name) {
  const t = reply.trim().toLowerCase();

  // Number choice
  const numMatch = t.match(/\b(\d+)\b/);
  if (numMatch) {
    const n = parseInt(numMatch[1]);
    if (n >= 1 && n <= candidates.length) return candidates[n - 1].item;
    // Maybe it's a member count
    const byCount = candidates.find(c => c.item.member_count === n);
    if (byCount) return byCount.item;
  }

  // Partial name match
  const best = scoreAll(reply, candidates.map(c => ({ ...c.item, name: labelFn(c) })));
  if (best[0] && best[0].score > 0.5) {
    // Map back to original candidate
    const label = labelFn(best[0].item);
    const found = candidates.find(c => labelFn(c) === label);
    return found ? found.item : null;
  }

  return null;
}
