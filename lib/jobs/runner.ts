import { getDb } from "@/lib/db";
import { errorMessage, logEvent, redact } from "@/lib/logger";
import { RUNNABLE, type JobRow, type State } from "./states";
import { runStep } from "./steps";

export type AdvanceResult = {
  status: "progressed" | "pending" | "busy" | "idle" | "failed";
  state: State;
  note?: string;
  error?: string;
};


/**
 * Runs exactly one step of one job. The atomic UPDATE is the lock: if another
 * request already holds it, this returns "busy" and nothing runs twice.
 */
export async function advanceJob(id: string): Promise<AdvanceResult | null> {
  const sql = await getDb();

  const claimed = await sql`
    update jobs set busy = true, updated_at = now()
    where id = ${id}::uuid
      and (busy = false or updated_at < now() - interval '6 minutes')
    returning *`;

  if (claimed.length === 0) {
    const [cur] = await sql`select state from jobs where id = ${id}::uuid`;
    if (!cur) return null;
    return { status: "busy", state: cur.state as State };
  }

  const job = claimed[0] as JobRow;
  if (!RUNNABLE.includes(job.state)) {
    await sql`update jobs set busy = false where id = ${id}::uuid`;
    return { status: "idle", state: job.state };
  }

  const started = Date.now();
  try {
    const res = await runStep(job);
    const attempts = res.attempts ?? job.attempts;
    await sql`
      update jobs set state = ${res.state}, attempts = ${attempts},
        data = data || ${JSON.stringify(res.data ?? {})}::jsonb,
        error = null, updated_at = now()
      where id = ${id}::uuid`;
    await logEvent(id, job.state, res.note ?? `${job.state} → ${res.state}`, {
      durationMs: Date.now() - started,
      detail: res.detail,
    });
    return { status: res.pending ? "pending" : "progressed", state: res.state, note: res.note };
  } catch (err) {
    const message = errorMessage(err);
    const stack = err instanceof Error && err.stack ? redact(err.stack) : undefined;
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
