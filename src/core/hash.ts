/**
 * Line identity.
 *
 * Review evidence cannot be stored against a line *number*: insert one import
 * at the top of a file and every number below it shifts, which would silently
 * transfer "I read this" from the line you read to the line you didn't. So
 * evidence is anchored to a hash of the line's content instead, and line
 * numbers are only ever a live, in-memory index.
 *
 * The hash trims surrounding whitespace so that a reformat or a re-indent does
 * not erase your memory of reading the line, while any change to the actual
 * tokens does.
 */
export function hashLine(text: string): string {
  const s = text.trim();
  // FNV-1a, 32-bit. Fast, dependency-free, and collisions only cost us a
  // mis-anchored line during re-attachment, never correctness of the diff.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function hashLines(lines: string[]): string[] {
  return lines.map(hashLine);
}
