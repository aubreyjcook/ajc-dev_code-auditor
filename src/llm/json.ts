/**
 * @module llm/json
 *
 * Robust extraction of a JSON value from free-form model output. Even in
 * "JSON mode" models occasionally wrap output in Markdown fences, prepend
 * commentary, or emit `<think>` blocks (reasoning models). This module strips
 * those and locates the first balanced object or array.
 */

/** Thrown when no parseable JSON could be found in the text. */
export class JsonExtractionError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = 'JsonExtractionError';
  }
}

/**
 * Extracts and parses the first JSON object or array found in `text`.
 *
 * Strategy, in order:
 *  1. Remove `<think>...</think>` reasoning blocks.
 *  2. If a ```json fenced block exists, use its contents.
 *  3. Try `JSON.parse` on the whole trimmed string.
 *  4. Scan for the first `{` or `[` and find its balanced counterpart,
 *     respecting string literals and escapes.
 */
export function extractJson<T = unknown>(text: string): T {
  let s = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence?.[1]) s = fence[1].trim();

  try {
    return JSON.parse(s) as T;
  } catch {
    // fall through to scanning
  }

  const start = findFirst(s, ['{', '[']);
  if (start === -1) throw new JsonExtractionError('No JSON object or array found in model output', text);

  const end = findBalancedEnd(s, start);
  if (end === -1) {
    // Attempt a lenient repair for truncated output: close open structures.
    const repaired = repairTruncated(s.slice(start));
    try {
      return JSON.parse(repaired) as T;
    } catch {
      throw new JsonExtractionError('Unbalanced JSON in model output (likely truncated)', text);
    }
  }

  const candidate = s.slice(start, end + 1);
  try {
    return JSON.parse(candidate) as T;
  } catch (err) {
    throw new JsonExtractionError(`Model output is not valid JSON: ${(err as Error).message}`, text);
  }
}

function findFirst(s: string, chars: string[]): number {
  let best = -1;
  for (const c of chars) {
    const i = s.indexOf(c);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  return best;
}

/** Returns the index of the bracket closing the one at `start`, or -1. */
function findBalancedEnd(s: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      const open = stack.pop();
      if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * Best-effort repair for output cut off by `max_tokens`. Repeatedly closes
 * whatever structures are open and, if the result still does not parse, cuts
 * the text back to the previous structural boundary (`,`, `{`, `[`) and
 * tries again. This salvages every complete finding emitted before the cut.
 */
function repairTruncated(s: string): string {
  let candidate = s;
  for (let attempt = 0; attempt < 200 && candidate.length > 1; attempt++) {
    const closed = closeOpenStructures(candidate);
    try {
      JSON.parse(closed);
      return closed;
    } catch {
      const cut = Math.max(candidate.lastIndexOf(','), candidate.lastIndexOf('{'), candidate.lastIndexOf('['));
      if (cut <= 0) break;
      candidate = candidate.slice(0, cut);
    }
  }
  return s;
}

/** Terminates an open string, drops a trailing comma, and appends missing closers. */
function closeOpenStructures(s: string): string {
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = inString ? `${s}"` : s;
  out = out.replace(/,\s*$/, '');
  while (stack.length) out += stack.pop() === '{' ? '}' : ']';
  return out;
}
