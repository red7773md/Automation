"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { RUNNABLE, STATE_LABEL, TIMELINE, type JobRow, type State } from "@/lib/jobs/states";
import { missingPictures } from "@/lib/jobs/pictures";
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
  skipCaption: "captioning",
};

// Jobs made before the Gemini picture check was removed: the step they are on is shown at the step that replaced it.
const LEGACY_STEP: Partial<Record<State, State>> = { verifying: "generating", awaiting_review: "captioning" };

const ROLE_LABEL = { hook: "Hook", point: "Point", cta: "Call to action" } as const;

const UPLOAD_MAX_SIDE = 2048; // a ChatGPT picture is about 1024 to 1536 pixels; the server resizes it again
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

/** One picture to make: its prompt, and for a carousel the slide's text it goes with. */
type Picture = { label: string; detail?: string; prompt: string };

function picturesOf(j: JobRow): Picture[] {
  if ((j.data.format ?? "post") !== "carousel") {
    return [{ label: "Picture", prompt: j.data.imagePrompt ?? j.data.plan?.imagePrompt ?? "" }];
  }
  return (j.data.carousel?.slides ?? []).map((s, i) => ({
    label: `${i + 1}. ${ROLE_LABEL[s.role]}`,
    detail: [s.figure, s.headline].filter(Boolean).join(" · ") || undefined,
    prompt: s.imagePrompt,
  }));
}

/** The address of a picture as the server keeps it. The timestamp makes a re-upload show at once. */
function pictureSrc(j: JobRow, i: number): string {
  const v = encodeURIComponent(j.updated_at);
  return (j.data.format ?? "post") === "carousel" ? `/api/jobs/${j.id}/draft?slide=${i}&v=${v}` : `/api/jobs/${j.id}/draft?v=${v}`;
}

/** Continue, or schedule the post for a time. Available once every picture is uploaded. */
function ContinueBox({ jobId, missing, onDone }: { jobId: string; missing: number[]; onDone: () => void }) {
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = missing.length === 0;

  async function send(scheduled: boolean) {
    setBusy(true);
    setError(null);
    try {
      let at: string | undefined;
      if (scheduled) {
        const time = new Date(when);
        if (!when || Number.isNaN(time.getTime())) throw new Error("Choose the time to post.");
        at = time.toISOString();
      }
      await api("POST", `/api/jobs/${jobId}/continue`, at ? { at } : {});
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        {ready
          ? "Every picture is uploaded. Continue writes the caption, the hashtags and the pinned comment, then posts. Or choose a time to post later."
          : `Upload the remaining pictures first: ${missing.map((i) => i + 1).join(", ")}.`}
      </p>
      <div className="row">
        <button className="primary" disabled={!ready || busy} onClick={() => send(false)}>
          Continue and post now
        </button>
      </div>
      <div className="row">
        <input
          type="datetime-local"
          value={when}
          disabled={!ready || busy}
          onChange={(e) => setWhen(e.target.value)}
          style={{ width: "auto" }}
        />
        <button disabled={!ready || busy || !when} onClick={() => send(true)}>
          Schedule the post
        </button>
      </div>
      {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}

/**
 * The pictures to make, one at a time: each prompt with a copy button, and an upload button for its picture.
 * Uploads are one at a time, so two pictures cannot overwrite each other's place in the job.
 */
function PicturesPanel({ job, onChanged }: { job: JobRow; onChanged: () => void }) {
  const pictures = picturesOf(job);
  const missing = missingPictures(job.data);
  const isCarousel = (job.data.format ?? "post") === "carousel";
  const [uploading, setUploading] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload(slot: number, file: File) {
    setUploading(slot);
    setError(null);
    try {
      const picture = await resizeForUpload(file);
      const res = await fetch(`/api/jobs/${job.id}/image?slot=${slot}`, {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: picture,
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Upload failed (HTTP ${res.status})`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(null);
    }
  }

  async function copy(slot: number, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(slot);
      setTimeout(() => setCopied((c) => (c === slot ? null : c)), 1500);
    } catch {
      setError("Clipboard is blocked in this browser. Select the prompt text and copy it by hand.");
    }
  }

  return (
    <section className="card stack">
      <h2 style={{ margin: 0 }}>{isCarousel ? `Make and upload the ${pictures.length} pictures` : "Make and upload the picture"}</h2>
      <p className="muted" style={{ margin: 0 }}>
        Copy each prompt into ChatGPT, make the picture, then upload it under its prompt. The pictures should contain no
        text: the app writes the slide text over them. Uploading again replaces a picture.
      </p>
      {pictures.map((p, i) => {
        const done = !missing.includes(i);
        return (
          <div key={i} className="stack" style={{ gap: 8 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>
                {p.label}
                {p.detail && <span className="muted"> · {p.detail}</span>}
              </strong>
              <span className={`badge ${done ? "ok" : "warn"}`}>{done ? "Uploaded" : "Waiting for the picture"}</span>
            </div>
            <pre className="block">{p.prompt || "(no prompt)"}</pre>
            <div className="row">
              <button disabled={!p.prompt} onClick={() => copy(i, p.prompt)}>
                {copied === i ? "Copied" : "Copy prompt"}
              </button>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                disabled={uploading !== null}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void upload(i, file);
                }}
              />
              {uploading === i && <span className="muted">Uploading…</span>}
            </div>
            {done && <img src={pictureSrc(job, i)} alt={`Picture ${i + 1}`} style={{ maxWidth: 240, borderRadius: 8 }} />}
          </div>
        );
      })}
      {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
      <ContinueBox jobId={job.id} missing={missing} onDone={onChanged} />
    </section>
  );
}

/** The pictures once they are made: their uploads and, for a carousel, the text drawn over them. */
function PictureGallery({ job }: { job: JobRow }) {
  const pictures = picturesOf(job);
  const missing = new Set(missingPictures(job.data));
  if (pictures.length === 0) return null;
  return (
    <div className="slides">
      {pictures.map((p, i) => (
        <figure key={i} className={`slide ${missing.has(i) ? "" : "ok"}`}>
          {missing.has(i) ? <div className="slide-empty">{i + 1}</div> : <img src={pictureSrc(job, i)} alt={p.label} />}
          <figcaption>
            <span className="muted">{p.label}</span>
            <span>{p.detail ?? (missing.has(i) ? "Not uploaded" : "Uploaded")}</span>
          </figcaption>
        </figure>
      ))}
    </div>
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
  // Pending external work (research polling) waits longer between ticks; a job whose start time is later waits longest.
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
        if (auto && RUNNABLE.includes(d.job.state) && !d.job.busy) {
          const r = await advance(false);
          if (stopped) return;
          later(
            r.status === "pending" ? 4000 : r.status === "busy" ? 2000 : r.status === "failed" ? 3000 : r.status === "scheduled" ? 15000 : 300,
          );
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
  const isCarousel = j.data.format === "carousel";
  const pictureCount = picturesOf(j).length;
  const uploaded = pictureCount - missingPictures(j.data).length;
  const waiting = j.state === "generating";
  const current = (j.state === "failed" ? j.data.failedStep : j.state) as State | undefined;
  const shown = current ? (LEGACY_STEP[current] ?? current) : undefined;
  const stepIndex = shown ? TIMELINE.indexOf(shown) : -1;
  const stepClass = (s: State) => {
    const i = TIMELINE.indexOf(s);
    if (j.state === "done") return "done";
    if (j.state === "failed") return i === stepIndex ? "failed" : i < stepIndex ? "done" : "";
    return i < stepIndex ? "done" : i === stepIndex ? "current" : "";
  };
  // Overall progress: the job's place on the timeline. A finished job is full, a failed one stops where it failed.
  const pct = j.state === "done" ? 100 : stepIndex < 0 ? 0 : Math.round((stepIndex / (TIMELINE.length - 1)) * 100);
  const canRun = RUNNABLE.includes(j.state) && !j.busy && !working;
  const switchedOff = WORKFLOW_KEYS.filter((k) => j.data.workflow?.[k]);
  const skippedStates = new Set<State>(
    switchedOff.map((k) => SKIP_STEP[k]).filter((s): s is State => s !== undefined),
  );
  // A switched-off step is marked on the timeline, except the step the job is on now.
  const isSkipped = (s: State) => skippedStates.has(s) && TIMELINE.indexOf(s) !== stepIndex;
  const startsLater = new Date(j.scheduled_at) > new Date();
  const timing = startsLater
    ? j.state === "captioning" || j.state === "publishing"
      ? `posts at ${new Date(j.scheduled_at).toLocaleString()}`
      : `starts ${new Date(j.scheduled_at).toLocaleString()}`
    : null;

  return (
    <>
      <section className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 className="title" style={{ marginBottom: 4 }}>{j.topic}</h2>
            <span className="muted">
              Job {j.id.slice(0, 8)} · created {new Date(j.created_at).toLocaleString()}
              {timing && <> · {timing}</>}
            </span>
          </div>
          <div className="row">
            {isCarousel && <span className="badge">Carousel · {pictureCount} slides</span>}
            <span className={`badge ${TONE[j.state] ?? ""}`}>{STATE_LABEL[j.state]}</span>
          </div>
        </div>

        <div
          className={`progress${j.busy ? " live" : ""}${j.state === "failed" ? " bad" : ""}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Job progress"
          style={{ marginTop: 16 }}
        >
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="grid2">
          <ol className="timeline">
            {TIMELINE.map((s) => {
              const skipped = isSkipped(s);
              const running = s === shown && j.busy;
              return (
                <li
                  key={s}
                  className={`${skipped ? "skipped" : stepClass(s)}${running ? " running" : ""}`}
                  style={skipped ? { opacity: 0.5 } : undefined}
                >
                  <span className="dot" />
                  {STATE_LABEL[s]}
                  {skipped && " · skipped"}
                </li>
              );
            })}
          </ol>
          <div className="stack">
            <p className="muted">
              {pictureCount > 0 && (waiting || j.state === "captioning" || j.state === "publishing" || j.state === "done")
                ? `Pictures uploaded: ${uploaded} of ${pictureCount}`
                : pictureCount > 0
                  ? `Pictures: ${pictureCount} to make`
                  : null}
              {j.busy ? " · a step is running…" : ""}
            </p>
            {switchedOff.length > 0 && (
              <p className="muted">Skipped for this job: {switchedOff.map((k) => WORKFLOW_LABEL[k]).join(" · ")}</p>
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
              <button className="primary" disabled={!canRun} onClick={() => run(() => advance(true))}>
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

      {waiting && <PicturesPanel job={j} onChanged={() => fetchDetail().catch(() => {})} />}

      {j.data.reportPath && (
        <section className="card row" style={{ justifyContent: "space-between" }}>
          <span className="muted">Research report, Markdown file</span>
          <a href={`/api/jobs/${id}/report`}>Download .md</a>
        </section>
      )}

      {!waiting && pictureCount > 0 && (
        <section className="card stack">
          <h2>{isCarousel ? "Slides" : "Picture"}</h2>
          <PictureGallery job={j} />
          {!isCarousel && j.data.imagePrompt && (
            <details>
              <summary className="muted">Prompt used</summary>
              <pre className="block">{j.data.imagePrompt}</pre>
            </details>
          )}
        </section>
      )}

      {j.data.verdict && (
        <section className="card stack">
          <h2>Picture check (older job)</h2>
          {j.data.verdict.skipped ? (
            <span className="badge" style={{ justifySelf: "start" }}>Skipped</span>
          ) : j.data.verdict.pass ? (
            <span className="badge ok" style={{ justifySelf: "start" }}>Passed</span>
          ) : (
            <span className="badge bad" style={{ justifySelf: "start" }}>Failed</span>
          )}
          {j.data.verdict.issues.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {j.data.verdict.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {j.state === "awaiting_review" && (
        <section className="card stack">
          <h2>Your approval (older job)</h2>
          <p className="banner">Approve to post, or reject to upload the pictures again.</p>
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
            placeholder="Optional: what should change?"
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
              {isCarousel ? "Reject and upload the slides again" : "Reject and upload a new picture"}
            </button>
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
            <summary className="muted">{isCarousel ? "Slide prompts" : "Image prompt"}</summary>
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

      <details className="card fold">
        <summary>Technical log · {logs.length} {logs.length === 1 ? "entry" : "entries"}</summary>
        <div className="stack" style={{ marginTop: 14 }}>
          <div className="row" style={{ justifyContent: "flex-end" }}>
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
        </div>
      </details>
    </>
  );
}
