// A long description is posted as numbered comments, "1/3", "2/3", ... The first one is pinned.
// Pure functions with no I/O.

/** Instagram allows 2200 characters per comment. The room left is for the "k/N" line. */
export const COMMENT_PART_LIMIT = 1900;
export const MAX_COMMENT_PARTS = 8;
/** The most text a description may hold: all its parts together. */
export const COMMENT_TOTAL_LIMIT = COMMENT_PART_LIMIT * MAX_COMMENT_PARTS;
const NUMBER_ROOM = 8; // "8/8" and its line break

/** Packs text into pieces of at most `room` characters. Paragraphs stay whole when they fit, then sentences, then words. */
function pieces(text: string, room: number): string[] {
  const out: string[] = [];
  let current = "";
  const add = (piece: string, separator: string) => {
    if (!current) {
      current = piece;
    } else if (`${current}${separator}${piece}`.length <= room) {
      current = `${current}${separator}${piece}`;
    } else {
      out.push(current);
      current = piece;
    }
  };
  for (const paragraph of text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)) {
    if (paragraph.length <= room) {
      add(paragraph, "\n\n");
      continue;
    }
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
      if (sentence.length <= room) {
        add(sentence, " ");
        continue;
      }
      for (const word of sentence.split(" ")) {
        for (let i = 0; i < word.length; i += room) add(word.slice(i, i + room), " ");
      }
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Splits a long description into numbered comments. A description that fits in one comment gets no number.
 * Past `maxParts` the text is cut, and the last part ends with an ellipsis so the cut is visible.
 */
export function splitComment(body: string, limit = COMMENT_PART_LIMIT, maxParts = MAX_COMMENT_PARTS): string[] {
  const text = body.trim();
  if (!text) return [""];
  const room = limit - NUMBER_ROOM;
  let parts = pieces(text, room);
  if (parts.length <= 1) return [parts[0] ?? ""];
  if (parts.length > maxParts) {
    parts = parts.slice(0, maxParts);
    const last = parts[maxParts - 1];
    parts[maxParts - 1] = `${last.slice(0, room - 2).trimEnd()} …`;
  }
  return parts.map((part, i) => `${i + 1}/${parts.length}\n${part}`);
}
