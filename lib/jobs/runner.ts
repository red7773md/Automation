import { getDb } from "@/lib/db";
import { errorMessage, logEvent, redact } from "@/lib/logger";
import { loadModels } from "@/lib/settings";
import { RUNNABLE, type JobRow, type State } from "./states";
import { runStep } from "./steps";
import { MAX_TRANSIENT_TRIES, isTransient, retryMinutes } from "./transient";

export type AdvanceResult = {
  status: "progressed" | "pending" | "busy" | "idle" | "failed" | "scheduled";
  state: State;
  note?: string;
  error?: string;
};

/**
 * Runs exactly one step of one job. The atomic UPDATE is the lock: if another
 * request already holds it, this returns "busy" and nothing runs twice.
 * A job whose start time has not come yet returns "scheduled". `force` ignores
 * the start time (the "Run next step" button sets it).
 */
export async function advanceJob(id: string, opts: { force?: boolean } = {}): Promise<AdvanceResult | null> {
  const force = opts.force === true;
  const sql = await getDb();

  const claimed = await sql`
    update jobs set busy = true, updated_at = now()
    where id = ${id}::uuid
      and (busy = false or updated_at < now() - interval '6 minutes')
      and (${force}::boolean or scheduled_at <= now())
    returning *`;

  if (claimed.length === 0) {
    const [cur] = await sql`select state, scheduled_at > now() as later from jobs where id = ${id}::uuid`;
    if (!cur) return null;
    if (cur.later && !force) return { status: "scheduled", state: cur.state as State };
    return { status: "busy", state: cur.state as State };
  }

  const job = claimed[0] as JobRow;
  if (!RUNNABLE.includes(job.state)) {
    await sql`update jobs set busy = false where id = ${id}::uuid`;
    return { status: "idle", state: job.state };
  }

  const started = Date.now();
  try {
    // Models are read per step, so a change in Settings applies to the next step.
    const res = await runStep(job, await loadModels());
    const attempts = res.attempts ?? job.attempts;
    // A step that worked clears the count of temporary problems and any wait.
    await sql`
      update jobs set state = ${res.state}, attempts = ${attempts},
        data = data || ${JSON.stringify({ ...(res.data ?? {}), transientTries: 0, retryAt: null })}::jsonb,
        error = null, updated_at = now()
      where id = ${id}::uuid`;
    if (!res.quiet) {
      await logEvent(id, job.state, res.note ?? `${job.state} → ${res.state}`, {
        durationMs: Date.now() - started,
        detail: res.detail,
      });
    }
    return { status: res.pending ? "pending" : "progressed", state: res.state, note: res.note };
  } catch (err) {
    const message = errorMessage(err);
    const stack = err instanceof Error && err.stack ? redact(err.stack) : undefined;
    const tries = Number(job.data.transientTries ?? 0) + 1;
    if (isTransient(message) && tries <= MAX_TRANSIENT_TRIES) {
      // Temporary: the job stays on this step and the tick tries it again after the wait. Nothing is lost.
      const wait = retryMinutes(tries);
      const retryAt = new Date(Date.now() + wait * 60_000).toISOString();
      const when = new Date(retryAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
      await sql`
        update jobs set error = ${message},
          data = data || ${JSON.stringify({ transientTries: tries, retryAt })}::jsonb,
          updated_at = now()
        where id = ${id}::uuid`;
      await logEvent(id, job.state, `Temporary problem, not a failure: ${message}. Trying again at ${when} IST (try ${tries} of ${MAX_TRANSIENT_TRIES}).`, {
        level: "warn",
        detail: stack,
        durationMs: Date.now() - started,
      });
      return { status: "pending", state: job.state, note: message, error: message };
    }
    await sql`
      update jobs set state = 'failed', error = ${message},
        data = data || ${JSON.stringify({ failedStep: job.state })}::jsonb,
        updated_at = now()
      where id = ${id}::uuid`;
    await logEvent(id, job.state, `Step failed: ${message}`, {
      level: "error",
      detail: stack,
      durationMs: Date.now() - started,
    });
    return { status: "failed", state: "failed", error: message };
  } finally {
    await sql`update jobs set busy = false where id = ${id}::uuid`;
  }
}
