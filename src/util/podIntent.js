/** Pure classifiers for Pod account actions. */

export function isPodDataRequest(text) {
  const t = String(text || '').toLowerCase().replace(/[’‘]/g, "'").trim();
  return /\b(attendance|attendence|bunk|marks?|grades?|result|internals?|pod data|present percentage|absent percentage|safe\s+bunk|kitni\s+class|kitna\s+percent)\b/.test(t)
    && !/\b(?:group|mass\s*bunk|everyone|sabhi|all students|class timetable|time\s*table|schedule|holiday|notice)\b/.test(t);
}

export function isPodLinkCommand(text) {
  const t = String(text || '').toLowerCase().trim();
  return t === '!link' || /\b(?:link\s+pod|pod\s+link|link\s+(?:my\s+)?account|connect\s+(?:my\s+)?pod|pod\s+connect|link\s+karo|pod\s+jod|account\s+link\s+kar)\b/.test(t);
}
