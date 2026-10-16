// Checks the agent's answer against what its tools actually returned. Every PR or issue
// number, every @person and every other number in the answer must appear in evidence
// the agent looked at in this run. Anything else is invented, and the answer is rejected.

export interface Seen {
  refs: Set<string>;    // "123" for PR or issue #123
  people: Set<string>;  // lower-case logins
  numbers: Set<string>; // every number that appeared in a tool result
}

export function emptySeen(): Seen {
  return { refs: new Set(), people: new Set(), numbers: new Set() };
}

export function remember(seen: Seen, toolText: string) {
  for (const m of toolText.matchAll(/#(\d+)/g)) seen.refs.add(m[1]);
  for (const m of toolText.matchAll(/@([A-Za-z0-9][A-Za-z0-9-]*)/g)) seen.people.add(m[1].toLowerCase());
  for (const m of toolText.matchAll(/\d+(?:\.\d+)?/g)) seen.numbers.add(normalise(m[0]));
}

const normalise = (n: string) => String(Number(n));

export function problems(answer: string, seen: Seen): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(/#(\d+)/g)) if (!seen.refs.has(m[1])) out.push(`#${m[1]} was not in any tool result`);
  for (const m of answer.matchAll(/@([A-Za-z0-9][A-Za-z0-9-]*)/g)) if (!seen.people.has(m[1].toLowerCase())) out.push(`@${m[1]} was not in any tool result`);
  // Other numbers: strip refs, dates and paths first, since their digits are checked above or are not claims.
  const rest = answer
    .replace(/#\d+/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/[\w.-]*\/[\w./-]*/g, " ")
    .replace(/\b[A-Za-z_]+\d+[A-Za-z_\d]*\b/g, " "); // identifiers like utf8, v4
  for (const m of rest.matchAll(/\d+(?:\.\d+)?/g)) {
    if (!seen.numbers.has(normalise(m[0]))) out.push(`the number ${m[0]} was not in any tool result`);
  }
  return [...new Set(out)];
}
