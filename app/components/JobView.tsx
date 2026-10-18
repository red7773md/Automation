"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import {
  MAX_GENERATIONS,
  RUNNABLE,
  STATE_LABEL,
  TIMELINE,
  type JobRow,
  type State,
} from "@/lib/jobs/states";
import { WORKFLOW_KEYS, WORKFLOW_LABEL, type WorkflowKey } from "@/lib/jobs/workflow";

type LogRow = {
  id: number;
  level: string;
  step: string;
  message: string;
  detail: string | null;
  duration_ms: number | null;
  created_at: string;
};
type Detail = { job: JobRow; logs: LogRow[] };
type Advance = { status: "progressed" | "pending" | "busy" | "idle" | "failed" | "scheduled"; state: State; error?: string };

const TONE: Partial<Record<State, string>> = { awaiting_review: "warn", done: "ok", failed: "bad" };

// The step each switch skips. Its place on the timeline is marked as skipped.
const SKIP_STEP: Partial<Record<WorkflowKey, State>> = {
  skipResearch: "researching",
  skipAnalysis: "analyzing",
  skipImage: "generating",
  skipVerify: "verifying",
  skipCaption: "captioning",
  skipApproval: "awaiting_review",
};

// The job waits for a picture: image generation is switched off and nothing was uploaded yet.
function waitsForUpload(j: JobRow): boolean {
  return j.state === "generating" && j.data.workflow?.skipImage === true && !j.data.uploadedDraftPath;
}

const UPLOAD_MAX_SIDE = 1080; // the server resizes again; this keeps the upload small
const UPLOAD_MAX_BYTES = 4 * 1024 * 1024; // Vercel refuses request bodies over about 4.5 MB

async function resizeForUpload(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("This picture could not be read. Try a JPEG or PNG.");
  }
  const scale = Math.min(1, UPLOAD_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot resize pictures.");
  ctx.fillStyle = "#ffffff"; // a transparent PNG becomes white rather than black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.9, 0.7, 0.5]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size <= UPLOAD_MAX_BYTES) return blob;
  }
  throw new Error("This picture is too large to send, even after resizing.");
}

function ImageUpload({ jobId, onDone }: { jobId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(file: File) {
    setBusy(true);
    setError(null);
    try {
      const picture = await resizeForUpload(file);
      const res = await fetch(`/api/jobs/${jobId}/image`, {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: picture,
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Upload failed (HTTP ${res.status})`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <h2 style={{ margin: 0 }}>Upload the image</h2>
      <p className="muted" style={{ margin: 0 }}>
        Image generation is switched off for this job, so the job waits here. Upload the picture to post. It is resized before the check.
      </p>
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void send(file);
        }}
      />
      {busy && <span className="muted">Uploading…</span>}
      {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
    </section>
  );
}

export default function JobView({ id }: { id: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [auto, setAuto] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [copied, setCopied] = useState(false);

  const fetchDetail = useCallback(async () => {
    const d = await api<Detail>("GET", `/api/jobs/${id}`);
    setDetail(d);
    return d;
  }, [id]);

  // force = true for the button: it runs now even if the start time has not come.
  const advance = useCallback(
    (force: boolean) => api<Advance>("POST", `/api/jobs/${id}/advance`, { force }),
    [id],
  );

  // Auto-run loop: fetch state, run one step if runnable, schedule the next tick.
  // Pending external work (research polling) waits longer between ticks.
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const later = (ms: number) => {
      if (!stopped) timer = window.setTimeout(tick, ms);
    };
    async function tick() {
      try {
        const d = await fetchDetail();
        if (stopped) return;
        setError(null);
        if (auto && RUNNABLE.includes(d.job.state) && !d.job.busy && !waitsForUpload(d.job)) {
          const r = await advance(false);
          if (stopped) return;
          later(r.status === "pending" ? 4000 : r.status === "busy" ? 2000 : r.status === "failed" ? 3000 : 300);
          return;
        }
        later(4000);
      } catch (err) {
        if (stopped) return;
        setError(err instanceof Error ? err.message : String(err));
        later(5000);
      }
    }
    tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [auto, fetchDetail, advance]);

  async function run(task: () => Promise<unknown>) {
    setWorking(true);
    try {
      await task();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
      await fetchDetail().catch(() => {});
    }
  }

  async function copyReport() {
    if (!detail) return;
    const j = detail.job;
    const header = [
      `Job ${j.id}`,
      `Topic: ${j.topic}`,
      `State: ${j.state} | attempts: ${j.attempts} | failed step: ${j.data.failedStep ?? "-"}`,
      `Error: ${j.error ?? "-"}`,
      `Updated: ${j.updated_at}`,
    ].join("\n");
    const lines = detail.logs.slice(-150).map(
      (l) =>
        `${l.created_at} [${l.level}] ${l.step}: ${l.message}${l.duration_ms != null ? ` (${l.duration_ms} ms)` : ""}${l.detail ? `\n${l.detail}` : ""}`,
    );
    try {
      await navigator.clipboard.writeText(`${header}\n\n--- LOG ---\n${lines.join("\n")}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Clipboard is blocked in this browser. Select the log text and copy it manually.");
    }
  }

  if (!detail) {
    return (
      <section className="card">
        {error ? <p className="error">{error}</p> : <p className="muted">Loading job…</p>}
      </section>
    );
  }

  const { job: j, logs } = detail;
  const current = j.state === "failed" ? j.data.failedStep : j.state;
  const stepIndex = TIMELINE.indexOf(current as State);
  const stepClass = (s: State) => {
    const i = TIMELINE.indexOf(s);
    if (j.state === "done") return "done";
    if (j.state === "failed") return i === stepIndex ? "failed" : i < stepIndex ? "done" : "";
    return i < stepIndex ? "done" : i === stepIndex ? "current" : "";
  };
  const canRun = RUNNABLE.includes(j.state) && !j.busy && !working && !waitsForUpload(j);
  const switchedOff = WORKFLOW_KEYS.filter((k) => j.data.workflow?.[k]);
  const skippedStates = new Set<State>(
    switchedOff.map((k) => SKIP_STEP[k]).filter((s): s is State => s !== undefined),
  );
  // A switched-off step is marked on the timeline, except the step the job is on now.
  const isSkipped = (s: State) => skippedStates.has(s) && TIMELINE.indexOf(s) !== stepIndex;

  return (
    <>
      <section className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>{j.topic}</h2>
            <span className="muted">
              Job {j.id.slice(0, 8)} · created {new Date(j.created_at).toLocaleString()}
              {new Date(j.scheduled_at) > new Date() && <> · starts {new Date(j.scheduled_at).toLocaleString()}</>}
            </span>
          </div>
          <span className={`badge ${TONE[j.state] ?? ""}`}>{STATE_LABEL[j.state]}</span>
        </div>

        <div className="grid2" style={{ marginTop: 16 }}>
          <ol className="timeline">
            {TIMELINE.map((s) => {
              const skipped = isSkipped(s);
              return (
                <li key={s} className={skipped ? "skipped" : stepClass(s)} style={skipped ? { opacity: 0.5 } : undefined}>
                  <span className="dot" />
                  {STATE_LABEL[s]}
                  {skipped && " · skipped"}
                </li>
              );
            })}
          </ol>
          <div className="stack">
            <p className="muted">
              Generation {j.attempts} of {MAX_GENERATIONS}
              {j.busy ? " · a step is running…" : ""}
            </p>
            {switchedOff.length > 0 && (
              <p className="muted">Switched off for this job: {switchedOff.map((k) => WORKFLOW_LABEL[k]).join(" · ")}</p>
            )}
            {logs.length > 0 && (
              <p className="muted">
                Latest: {logs[logs.length - 1].message} · {new Date(logs[logs.length - 1].created_at).toLocaleTimeString()}
              </p>
            )}
            <label className="row">
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => setAuto(e.target.checked)}
                style={{ width: "auto" }}
              />
              Also run steps from this page
            </label>
            <div className="row">
              <button
                className="primary"
                disabled={!canRun}
                onClick={() => run(() => advance(true))}
              >
                Run next step
              </button>
              {j.state === "failed" && (
                <button disabled={working} onClick={() => run(() => api("POST", `/api/jobs/${id}/retry`))}>
                  Retry from “{STATE_LABEL[j.data.failedStep ?? "queued"]}”
                </button>
              )}
            </div>
          </div>
        </div>

        {j.error && <pre className="block error" style={{ marginTop: 12 }}>{j.error}</pre>}
        {error && <p className="error" style={{ marginTop: 12 }}>{error}</p>}
      </section>

      {waitsForUpload(j) && <ImageUpload jobId={id} onDone={() => fetchDetail().catch(() => {})} />}

      {j.data.reportPath && (
        <section className="card row" style={{ justifyContent: "space-between" }}>
          <span className="muted">Research report, Markdown file</span>
          <a href={`/api/jobs/${id}/report`}>Download .md</a>
        </section>
      )}

      {j.data.draftPath && (
        <section className="card grid2">
          <div className="stack">
            <h2>Latest image</h2>
            <img className="preview" src={`/api/jobs/${id}/draft?v=${j.attempts}`} alt="Generated draft" />
            {j.data.lastPrompt && <p className="muted">Prompt: {j.data.lastPrompt}</p>}
          </div>
          <div className="stack">
            <h2>Verification</h2>
            {j.data.verdict?.skipped ? (
              <span className="badge" style={{ justifySelf: "start" }}>Skipped (switched off)</span>
            ) : j.data.verdict ? (
              j.data.verdict.pass ? (
                <span className="badge ok" style={{ justifySelf: "start" }}>Passed</span>
              ) : (
                <span className="badge bad" style={{ justifySelf: "start" }}>Failed</span>
              )
            ) : (
              <span className="muted">Not checked yet</span>
            )}
            {j.data.verdict && j.data.verdict.issues.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {j.data.verdict.issues.map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            )}

            {j.state === "awaiting_review" && (
              <>
                <p className="banner">
                  {j.data.verdict?.skipped
                    ? "The image check is switched off. Approve to post."
                    : j.data.verdict && !j.data.verdict.pass
                      ? "Verification failed twice. Decide whether to post this image or regenerate it."
                      : "Verification passed. Approve to post."}
                </p>
                <div className="row">
                  <button
                    className="primary"
                    disabled={working}
                    onClick={() => run(() => api("POST", `/api/jobs/${id}/review`, { action: "approve" }))}
                  >
                    Approve &amp; post
                  </button>
                </div>
                <textarea
                  placeholder="Optional: what should change? This is added to the image prompt."
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                />
                <div className="row">
                  <button
                    disabled={working}
                    onClick={() =>
                      run(async () => {
                        await api("POST", `/api/jobs/${id}/review`, { action: "reject", feedback });
                        setFeedback("");
                      })
                    }
                  >
                    Reject &amp; regenerate
                  </button>
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {j.data.plan && (
        <section className="card stack">
          <h2>Post content</h2>
          <span className="muted">Caption (shown in the feed)</span>
          <pre className="block">{j.data.plan.caption}</pre>
          <details>
            <summary className="muted">Detail comment (posted, then pinned)</summary>
            <pre className="block">{j.data.plan.commentBody}</pre>
          </details>
          <details>
            <summary className="muted">Image prompt</summary>
            <pre className="block">{j.data.plan.imagePrompt}</pre>
          </details>
          {j.data.publish && (
            <p className="muted">
              Instagram: media {j.data.publish.mediaId ?? "-"} · comment {j.data.publish.commentId ?? "-"} · pinned{" "}
              {j.data.publish.pinned ? "yes" : "no"}
              {j.data.publish.dryRun ? " · DRY RUN (nothing was sent)" : ""}
            </p>
          )}
        </section>
      )}

      <section className="card stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Technical log</h2>
          <button onClick={copyReport}>{copied ? "Copied" : "Copy debug report"}</button>
        </div>
        <div className="logs">
          {logs.length === 0 && <div className="muted">No log entries yet.</div>}
          {logs.map((l) => (
            <div key={l.id} className={`log ${l.level}`}>
              <span className="t">{new Date(l.created_at).toLocaleTimeString()} </span>
              <span className="s">[{l.step}] </span>
              <span className="m">{l.message}</span>
              {l.duration_ms != null && <span className="t"> ({l.duration_ms} ms)</span>}
              {l.detail && (
                <details>
                  <summary>details</summary>
                  <pre>{l.detail}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
