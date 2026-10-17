import { getDb } from "./db";

type Level = "info" | "warn" | "error" | "debug";

const SECRET_ENV_KEYS = [
  "AUTH_SECRET",
  "COOKIE_ENCRYPTION_KEY",
  "BLOB_READ_WRITE_TOKEN",
  "ADMIN_PASSWORD_HASH",
  "DATABASE_URL",
  "INSTAGRAM_MCP_URL",
  "GEMINI_BRIDGE_URL",
  "CHATGPT_BRIDGE_URL",
] as const;

/** Removes secrets from any text before it is stored, displayed or logged. */
export function redact(text: string): string {
  let out = text;
  for (const key of SECRET_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.length >= 6) out = out.split(value).join(`[${key}]`);
  }
  return out
    .replace(/\b(auth|key|token|secret|api_?key)=[^&\s"'<>]+/gi, "$1=[REDACTED]")
    .replace(/(x-provider-cookie["':=\s]+)[^\r\n"']+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/\b(__Secure-[\w.-]+|__Host-[\w.-]+|sessionid|sessionToken)=[^;\s"'<>]+/g, "$1=[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED_KEY]")
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, "$1[REDACTED]@");
}

export function errorMessage(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}

/** Writes a line to the job's technical log (shown in the UI) and to the server console. */
export async function logEvent(
  jobId: string,
  step: string,
  message: string,
  opts: { level?: Level; detail?: unknown; durationMs?: number } = {},
): Promise<void> {
  const level = opts.level ?? "info";
  const text = redact(message);
  const detail =
    opts.detail === undefined || opts.detail === null
      ? null
      : redact(typeof opts.detail === "string" ? opts.detail : JSON.stringify(opts.detail, null, 2));

  (level === "error" ? console.error : console.log)(`[job ${jobId.slice(0, 8)}] ${step}: ${text}`);

  try {
    const sql = await getDb();
    await sql`
      insert into job_logs (job_id, level, step, message, detail, duration_ms)
      values (${jobId}::uuid, ${level}, ${step}, ${text}, ${detail}, ${opts.durationMs ?? null})`;
  } catch (err) {
    console.error("Could not write job log:", errorMessage(err));
  }
}
