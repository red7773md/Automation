// The Gemini image tool refuses a prompt longer than this ("Prompt is longer than 1000 characters").
export const MAX_IMAGE_PROMPT = 1000;

/** The text cut to at most `max` characters, at the last space when that is not far back. */
export function cutTo(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";
  const head = text.slice(0, max);
  const space = head.lastIndexOf(" ");
  return (space > max / 2 ? head.slice(0, space) : head).trimEnd();
}
