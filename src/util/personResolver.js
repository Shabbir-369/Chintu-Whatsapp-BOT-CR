import { scoreAll } from './fuzzy.js';
import { normalise } from './text.js';

function aliases(person) {
  return [...new Set([person.display_name, person.push_name, ...(Array.isArray(person.phone_numbers) ? person.phone_numbers : [])].map(v => String(v || '').trim()).filter(Boolean))];
}

/** Resolve a person only when there is one strong, clearly separated match. */
export function findPersonTarget(query, people) {
  if (!people.length) return { match: null, candidates: [] };
  const wanted = normalise(query || '');
  if (!wanted) return { match: null, candidates: people.slice(0, 10).map(item => ({ item, score: 0 })) };

  // Phone numbers are often written with spaces or a leading + in owner commands.
  // Compare digits separately so the canonical number alias resolves exactly.
  const wantedDigits = String(query || '').replace(/\D/g, '');
  if (wantedDigits.length >= 7) {
    const phoneMatches = people.filter(person => {
      const phones = [person.display_name, ...(Array.isArray(person.phone_numbers) ? person.phone_numbers : [])];
      return phones.some(value => String(value || '').replace(/\D/g, '') === wantedDigits);
    });
    if (phoneMatches.length === 1) return { match: phoneMatches[0], candidates: [{ item: phoneMatches[0], score: 1 }] };
    if (phoneMatches.length > 1) return { match: null, candidates: phoneMatches.map(item => ({ item, score: 1 })) };
  }

  const exact = people.filter(person => aliases(person).some(name => normalise(name) === wanted));
  // A short first-name/nickname must not silently select one person when other
  // contacts have the same name as a prefix (e.g. "Meenu" vs "Meenu Shah").
  const prefixMatches = !wanted.includes(' ')
    ? people.filter(person => aliases(person).some(name => normalise(name).startsWith(`${wanted} `)))
    : [];
  const exactAndPrefix = [...new Map([...exact, ...prefixMatches].map(person => [person.id, person])).values()];
  if (exactAndPrefix.length === 1) return { match: exactAndPrefix[0], candidates: [{ item: exactAndPrefix[0], score: 1 }] };
  if (exactAndPrefix.length > 1) {
    return { match: null, candidates: exactAndPrefix.map(item => ({ item, score: exact.includes(item) ? 1 : 0.9 })) };
  }

  const byId = new Map();
  for (const person of people) {
    const names = aliases(person);
    const scored = scoreAll(wanted, names.map(name => ({ ...person, name })));
    const score = scored[0]?.score || 0;
    const existing = byId.get(person.id);
    if (!existing || score > existing.score) byId.set(person.id, { item: person, score });
  }
  const scored = [...byId.values()].sort((a, b) => b.score - a.score);
  const first = scored[0];
  const second = scored[1];
  const gap = first ? first.score - (second?.score ?? 0) : 0;
  if (wanted.length >= 3 && first?.score >= 0.85 && gap >= 0.15) {
    return { match: first.item, candidates: [first] };
  }

  const plausible = scored.filter(c => c.score >= 0.28).slice(0, 10);
  return { match: null, candidates: plausible.length ? plausible : scored.slice(0, 10) };
}
