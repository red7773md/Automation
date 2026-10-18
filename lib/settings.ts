// Settings that the admin edits in the web UI and the pipeline reads on every step.
// Stored as JSON rows in app_settings, so a change applies to the next step without a redeploy.
import { getDb } from "./db";

export const TASKS = ["research", "analysis", "caption", "image", "verify"] as const;
export type Task = (typeof TASKS)[number];

export const TASK_LABEL: Record<Task, string> = {
  research: "Deep research",
  analysis: "Analysis (separate chat)",
  caption: "Caption, hashtags and pinned comment",
  image: "Image generation",
  verify: "Image check",
};

export const TASK_HINT: Record<Task, string> = {
  research: "The long research run on the topic.",
  analysis: "Reads the report in a new chat and writes the angle and image prompt.",
  caption: "Writes the feed caption with hashtags and the pinned comment.",
  image: "Makes the picture from the image prompt.",
  verify: "Checks the picture against the prompt. The Gemini server needs its image tool to accept a model for this to apply.",
};

/** Empty string means the account's default model. */
export type ModelSettings = Record<Task, string>;

/** Names the gemini-webapi library accepts as plain strings. Accounts without Advanced or Plus only get the base ones. */
export const MODEL_PRESETS = [
  "gemini-pro",
  "gemini-flash",
  "gemini-flash-lite",
  "gemini-pro-plus",
  "gemini-flash-plus",
  "gemini-flash-lite-plus",
  "gemini-pro-advanced",
  "gemini-flash-advanced",
  "gemini-flash-lite-advanced",
];

const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function defaultModels(): ModelSettings {
  return { research: "", analysis: "", caption: "", image: "", verify: "" };
}

/** Accepts a partial or full object. Unknown keys are ignored. A bad model name is refused, not silently dropped. */
export function normalizeModels(input: unknown): ModelSettings {
  if (!input || typeof input !== "object") throw new Error("Models must be an object with one entry per task");
  const out = defaultModels();
  for (const task of TASKS) {
    const raw = (input as Record<string, unknown>)[task];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") throw new Error(`${TASK_LABEL[task]}: the model name must be text`);
    const name = raw.trim();
    if (name && !MODEL_RE.test(name)) {
      throw new Error(`${TASK_LABEL[task]}: "${name}" is not a valid model name. Use letters, digits, dots and dashes, such as gemini-pro`);
    }
    out[task] = name;
  }
  return out;
}

export async function loadModels(): Promise<ModelSettings> {
  const sql = await getDb();
  const rows = await sql`select value from app_settings where key = 'models'`;
  if (!rows[0]) return defaultModels();
  return normalizeModels(rows[0].value);
}

export async function saveModels(models: ModelSettings): Promise<void> {
  const sql = await getDb();
  const value = JSON.stringify(models);
  await sql`
    insert into app_settings (key, value, updated_at)
    values ('models', ${value}::jsonb, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}
