import { findGroupTarget } from './groupResolver.js';
import { findPersonTarget } from './personResolver.js';

/** Resolve a person/group target safely; unresolved names return selectable candidates. */
export function resolveNamedTarget(name, people, groups) {
  const person = findPersonTarget(name, people);
  const group = findGroupTarget(name, groups);

  const personMatch = person.match ? { ...person.match, __targetType: 'person' } : null;
  const groupMatch = group.match ? { ...group.match, __targetType: 'group' } : null;

  // Even when one side has a strong match, surface a choice if a similarly strong
  // match of the other kind exists. A contact and a group can share a name.
  const personOptions = personMatch
    ? [{ item: personMatch, score: 1 }]
    : person.candidates.filter(c => c.score >= 0.65).map(c => ({ item: { ...c.item, __targetType: 'person' }, score: c.score }));
  const groupOptions = groupMatch
    ? [{ item: groupMatch, score: 1 }]
    : group.candidates.filter(c => c.score >= 0.65).map(c => ({ item: { ...c.item, __targetType: 'group' }, score: c.score }));

  if (personOptions.length && groupOptions.length) {
    const deduped = new Map();
    for (const candidate of [...personOptions, ...groupOptions]) {
      const item = candidate.item;
      const key = `${item.__targetType}:${item.id || item.jid}`;
      const existing = deduped.get(key);
      if (!existing || existing.score < candidate.score) deduped.set(key, candidate);
    }
    return { match: null, ambiguous: true, type: null, candidates: [...deduped.values()].sort((a, b) => b.score - a.score).slice(0, 10) };
  }
  if (personMatch) return { match: personMatch, ambiguous: false, candidates: [{ item: personMatch, score: 1 }], type: 'person' };
  if (groupMatch) return { match: groupMatch, ambiguous: false, candidates: [{ item: groupMatch, score: 1 }], type: 'group' };

  const peopleChoices = person.candidates.map(c => ({ item: { ...c.item, __targetType: 'person' }, score: c.score }));
  const groupChoices = group.candidates.map(c => ({ item: { ...c.item, __targetType: 'group' }, score: c.score }));
  let candidates = [...peopleChoices, ...groupChoices].sort((a, b) => b.score - a.score);
  const meaningful = candidates.filter(c => c.score >= 0.28);
  if (meaningful.length) {
    candidates = meaningful.slice(0, 10);
  } else {
    // With no useful textual match, keep both target kinds represented so the
    // owner can still choose a person or a group by number.
    candidates = [...groupChoices.slice(0, 5), ...peopleChoices.slice(0, 5)];
  }
  return { match: null, ambiguous: candidates.length > 0, candidates, type: null };
}
