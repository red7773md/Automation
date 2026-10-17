export function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Pulls the first JSON object out of a model reply (models sometimes add prose or code fences). */
export function extractJson(text: string): Record<string, any> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const preview = JSON.stringify(text.slice(0, 200));
  if (start === -1 || end <= start) throw new Error(`The reply contained no JSON object. Start of reply: ${preview}`);
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error(`The reply JSON could not be parsed (${(err as Error).message}). Start of reply: ${preview}`);
  }
}

/** Finds the first string or number stored under one of the given keys, searching nested objects too. */
export function findValue(data: unknown, keys: string[]): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  for (const key of keys) {
    const v = record[key];
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  for (const v of Object.values(record)) {
    const found = findValue(v, keys);
    if (found) return found;
  }
  return undefined;
}
