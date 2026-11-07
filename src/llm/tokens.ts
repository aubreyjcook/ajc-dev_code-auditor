/**
 * @module llm/tokens
 *
 * Cheap, tokenizer-free token estimation used for budgeting how much material
 * fits into one request. Exact counts differ per model, so we bias high:
 * code and HTML tokenize less efficiently than prose.
 */

/** Average characters per token assumed for source code / markup. */
const CHARS_PER_TOKEN_CODE = 3.2;

/** Average characters per token assumed for natural-language prose. */
const CHARS_PER_TOKEN_PROSE = 4;

/**
 * Estimates the token count of a string.
 *
 * @param text - Input text.
 * @param kind - `code` (default) uses a more conservative ratio than `prose`.
 */
export function estimateTokens(text: string, kind: 'code' | 'prose' = 'code'): number {
  if (!text) return 0;
  const ratio = kind === 'code' ? CHARS_PER_TOKEN_CODE : CHARS_PER_TOKEN_PROSE;
  return Math.ceil(text.length / ratio);
}

/**
 * Truncates `text` so that it fits within roughly `maxTokens`, appending a
 * marker so the model knows content was cut.
 */
export function truncateToTokens(text: string, maxTokens: number, kind: 'code' | 'prose' = 'code'): string {
  const ratio = kind === 'code' ? CHARS_PER_TOKEN_CODE : CHARS_PER_TOKEN_PROSE;
  const maxChars = Math.floor(maxTokens * ratio);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 40))}\n/* ... truncated by auditor ... */\n`;
}
