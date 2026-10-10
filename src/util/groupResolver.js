import { scoreAll } from './fuzzy.js';
import { normalise } from './text.js';

export function normalizeGroupName(value) {
  return normalise(String(value || '').replace(/\b(?:whatsapp\s+)?group\b/gi, ' ')).trim();
}

/**
 * Resolve a group only when the name is safely identifiable. Otherwise return
 * candidates for a numbered clarification; never silently choose a weak match.
 * @param {string|null|undefined} query
 * @param {Array<object>} groups
 * @returns {{match: object|null, candidates: Array<{item: object, score: number}>}}
 */
export function findGroupTarget(query, groups) {
  if (!groups.length) return { match: null, candidates: [] };
  const wanted = normalizeGroupName(query);
  if (!wanted) return { match: null, candidates: groups.map(item => ({ item, score: 0 })) };

  const exact = groups.filter(g => normalizeGroupName(g.subject) === wanted);
  if (exact.length === 1) return { match: exact[0], candidates: [{ item: exact[0], score: 1 }] };
  if (exact.length > 1) return { match: null, candidates: exact.map(item => ({ item, score: 1 })) };

  const scored = scoreAll(wanted, groups.map(g => ({ ...g, name: g.subject })));
  const first = scored[0];
  const second = scored[1];
  const gap = first ? first.score - (second?.score ?? 0) : 0;

  // Avoid silently selecting generic/short names such as "IT" or "club".
  if (wanted.length >= 3 && first?.score >= 0.85 && gap >= 0.15) {
    return { match: first.item, candidates: [first] };
  }

  const plausible = scored.filter(c => c.score >= 0.28).slice(0, 10);
  return {
    match: null,
    candidates: plausible.length ? plausible : groups.map(item => ({ item, score: 0 })),
  };
}
