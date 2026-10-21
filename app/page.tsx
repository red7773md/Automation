"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import SkipPicker, { type StepOption } from "@/app/components/SkipPicker";
import { api } from "@/lib/client";
import { CAROUSEL_MAX, CAROUSEL_MIN } from "@/lib/jobs/carousel";
import { STATE_LABEL, type State } from "@/lib/jobs/states";
import { MANUAL_LIMITS, type ManualInputs, type ManualKey } from "@/lib/jobs/workflow";

type JobSummary = {
  id: string;
  topic: string;
  state: State;
  attempts: number;
  error: string | null;
  busy: boolean;
  scheduled_at: string;
  updated_at: string;
  format: string | null;
  research: string | null;
};
type Status = {
  mode: "mock" | "live";
  transports: { gemini: string; chatgpt: string; instagram: boolean };
  imageProvider: string;
  gemini: { configured: boolean };
  chatgpt: { configured: boolean };
};

type Check = { ok: boolean; message: string };
type HealthReport = { mode: "mock" | "live"; gemini: { tools: Check; session: Check }; instagram: Check };

const TONE: Partial<Record<State, string>> = { awaiting_review: "warn", done: "ok", failed: "bad" };

type SwitchInfo = { id: string; label: string; hint: string };
type SavedWorkflow = {
  workflow: Record<string, boolean>;
  workflowSwitches: SwitchInfo[];
  carousel: { slideCount: number };
};
type TextBox = { key: ManualKey; label: string; hint?: string; rows: number };
type Format = "post" | "carousel";

// The text boxes each switch asks for. A box appears only while its switch is on.
const TEXT_FOR: Partial<Record<string, TextBox[]>> = {
  skipResearch: [
    { key: "report", label: "Research report", hint: "Paste the whole report. It is sent to the analysis as a file.", rows: 10 },
  ],
  skipAnalysis: [
    { key: "imagePrompt", label: "Image prompt", hint: "Describe the picture for the image generator.", rows: 4 },
    { key: "analysis", label: "Analysis (optional)", hint: "Points for the caption. Leave empty to use the start of the report.", rows: 4 },
  ],
  skipCaption: [
    { key: "caption", label: "Caption with hashtags", rows: 5 },
    { key: "commentBody", label: "Pinned comment", hint: "The full details for the pinned comment.", rows: 5 },
  ],
};

// A carousel asks for one prompt per slide where a single post asks for one image prompt.
const CAROUSEL_TEXT: Partial<Record<string, TextBox[]>> = {
  skipAnalysis: [
    {
      key: "slides",
      label: "Slide prompts",
      hint: "One image prompt per line. The first line is the hook; each line after it is one slide.",
      rows: 8,
    },
    { key: "analysis", label: "Analysis (optional)", hint: "Points for the caption. Leave empty to use the start of the report.", rows: 4 },
  ],
};

const CAROUSEL_STEP_TEXT: Record<string, Partial<StepOption>> = {
  skipAnalysis: {
    label: "Analysis (write the slide prompts yourself)",
    hint: "No separate Gemini chat. You give one image prompt per slide.",
  },
};

function boxesFor(switchId: string, format: Format): TextBox[] {
  return (format === "carousel" ? CAROUSEL_TEXT[switchId] : undefined) ?? TEXT_FOR[switchId] ?? [];
}

/** A carousel makes one picture per slide, so skipping image generation does not apply to it. */
function stepsFor(steps: StepOption[], format: Format): StepOption[] {
  if (format !== "carousel") return steps;
  return steps.filter((s) => s.id !== "skipImage").map((s) => ({ ...s, ...CAROUSEL_STEP_TEXT[s.id] }));
}

/** Only the text boxes of switches that are on are sent, so text left in a hidden box is not stored. */
function manualForSwitches(wf: Record<string, boolean>, manual: ManualInputs, format: Format): ManualInputs {
  const out: ManualInputs = {};
  for (const id of Object.keys(wf)) {
    if (!wf[id]) continue;
    for (const box of boxesFor(id, format)) {
      const text = manual[box.key]?.trim();
      if (text) out[box.key] = text;
    }
  }
  return out;
}

function CheckRow({ label, result }: { label: string; result: Check }) {
  return (
    <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
      <span>{label}</span>
      <span className={`badge ${result.ok ? "ok" : "bad"}`}>{result.ok ? "Ready" : "Not ready"}</span>
      <span className="muted" style={{ flex: "1 1 260px" }}>{result.message}</span>
    </div>
  );
}

export default function Dashboard() {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [startAt, setStartAt] = useState(""); // local date and time from the picker; empty means now
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<SavedWorkflow | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [wf, setWf] = useState<Record<string, boolean>>({});
  const [manual, setManual] = useState<ManualInputs>({});
  const [format, setFormat] = useState<Format>("post");
  const [slideCount, setSlideCount] = useState("8"); // text, so a half-typed number can be edited
  const [research, setResearch] = useState<"deep" | "quick">("deep");

  async function checkServers() {
    setChecking(true);
    setHealthError(null);
    try {
      setHealth(await api<HealthReport>("POST", "/api/health"));
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }

  const load = useCallback(
    () =>
      api<{ jobs: JobSummary[] }>("GET", "/api/jobs")
        .then((d) => setJobs(d.jobs))
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    api<Status>("GET", "/api/providers").then(setStatus).catch(() => {});
    api<SavedWorkflow>("GET", "/api/settings")
      .then((d) => {
        setDefaults(d);
        setWf(d.workflow);
        setSlideCount(String(d.carousel.slideCount));
      })
      .catch((e) => setDefaultsError(e instanceof Error ? e.message : String(e)));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  function chooseFormat(next: Format) {
    setFormat(next);
    // A carousel cannot skip image generation, so that switch goes off when a carousel is chosen.
    if (next === "carousel") setWf((w) => ({ ...w, skipImage: false }));
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const body: {
        topic: string;
        format: Format;
        research: "deep" | "quick";
        scheduledAt?: string;
        workflow?: Record<string, boolean>;
        manual?: ManualInputs;
        slideCount?: number;
      } = { topic, format, research };
      if (defaults) {
        // Without the saved defaults loaded, the server applies them itself.
        body.workflow = wf;
        body.manual = manualForSwitches(wf, manual, format);
      }
      if (format === "carousel") {
        const n = Number(slideCount);
        if (!Number.isInteger(n) || n < CAROUSEL_MIN || n > CAROUSEL_MAX) {
          throw new Error(`The number of slides must be a whole number from ${CAROUSEL_MIN} to ${CAROUSEL_MAX}`);
        }
        body.slideCount = n;
      }
      if (startAt) {
        const when = new Date(startAt); // the picker is in this browser's local time
        if (Number.isNaN(when.getTime())) throw new Error("Choose a valid start time");
        body.scheduledAt = when.toISOString();
      }
      const { id } = await api<{ id: string }>("POST", "/api/jobs", body);
      router.push(`/jobs/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  }

  const readyToGoLive =
    status &&
    status.transports.gemini !== "none" &&
    status.transports.instagram &&
    (status.imageProvider !== "chatgpt" || status.transports.chatgpt !== "none");

  return (
    <>
      {status?.mode === "mock" && (
        <p className="banner">
          Mock mode. Nothing calls Gemini, ChatGPT or Instagram, and nothing is posted. Set PROVIDER_MODE=live in Vercel when the servers are ready.
        </p>
      )}
      {status?.mode === "live" && !readyToGoLive && (
        <p className="banner">Live mode is on, but at least one server URL is missing. Check the Connections panel in Settings.</p>
      )}

      <section className="card">
        <h2>New post</h2>
        <form onSubmit={create} className="stack">
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Topic, for example: why morning walks improve focus"
            maxLength={500}
          />
          <fieldset className="stack" style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
            <legend className="muted" style={{ padding: 0, marginBottom: 6 }}>What do you want to make?</legend>
            <label className="row" style={{ alignItems: "flex-start", gap: 10 }}>
              <input
                type="radio"
                name="format"
                checked={format === "post"}
                onChange={() => chooseFormat("post")}
                style={{ marginTop: 4 }}
              />
              <span className="stack" style={{ gap: 2 }}>
                <span>Single post</span>
                <span className="muted" style={{ fontSize: "0.85em" }}>One picture and its caption.</span>
              </span>
            </label>
            <label className="row" style={{ alignItems: "flex-start", gap: 10 }}>
              <input
                type="radio"
                name="format"
                checked={format === "carousel"}
                onChange={() => chooseFormat("carousel")}
                style={{ marginTop: 4 }}
              />
              <span className="stack" style={{ gap: 2 }}>
                <span>Carousel</span>
                <span className="muted" style={{ fontSize: "0.85em" }}>
                  Square slides people swipe through. The first slide is the hook that makes them want the next.
                </span>
              </span>
            </label>
            {format === "carousel" && (
              <label className="stack" style={{ gap: 4, marginTop: 6 }}>
                <span>Number of slides</span>
                <span className="muted" style={{ fontSize: "0.85em" }}>
                  From {CAROUSEL_MIN} to {CAROUSEL_MAX}. Gemini may plan fewer when the topic needs fewer.
                </span>
                <input
                  type="number"
                  min={CAROUSEL_MIN}
                  max={CAROUSEL_MAX}
                  step={1}
                  value={slideCount}
                  onChange={(e) => setSlideCount(e.target.value)}
                  style={{ maxWidth: 120 }}
                />
              </label>
            )}
          </fieldset>
          <fieldset className="stack" style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
            <legend className="muted" style={{ padding: 0, marginBottom: 6 }}>How to research the topic</legend>
            <label className="row" style={{ alignItems: "flex-start", gap: 10 }}>
              <input
                type="radio"
                name="research"
                checked={research === "deep"}
                onChange={() => setResearch("deep")}
                style={{ marginTop: 4 }}
              />
              <span className="stack" style={{ gap: 2 }}>
                <span>Deep research</span>
                <span className="muted" style={{ fontSize: "0.85em" }}>
                  Gemini reads widely and writes a full report. Slower, often 5 to 10 minutes.
                </span>
              </span>
            </label>
            <label className="row" style={{ alignItems: "flex-start", gap: 10 }}>
              <input
                type="radio"
                name="research"
                checked={research === "quick"}
                onChange={() => setResearch("quick")}
                style={{ marginTop: 4 }}
              />
              <span className="stack" style={{ gap: 2 }}>
                <span>Quick search and check</span>
                <span className="muted" style={{ fontSize: "0.85em" }}>
                  One web search. Each fact is checked against the page it comes from, and those sources are added to the pinned comment. Saves time.
                </span>
              </span>
            </label>
            {wf.skipResearch && (
              <span className="muted" style={{ fontSize: "0.85em" }}>Research is switched off for this job, so you paste the report yourself.</span>
            )}
          </fieldset>
          <label className="stack">
            <span className="muted">Start at (optional, your local time). Leave empty to start now.</span>
            <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
          </label>
          <div className="stack">
            <span className="muted">Steps for this job. You can skip one; the job then moves on to the next step.</span>
            {!defaults ? (
              <span className="muted">{defaultsError ?? "Loading steps…"}</span>
            ) : (
              <>
                <SkipPicker steps={stepsFor(defaults.workflowSwitches, format)} value={wf} onChange={setWf} />
                {defaults.workflowSwitches
                  .filter((s) => wf[s.id])
                  .flatMap((s) => boxesFor(s.id, format))
                  .map((box) => (
                    <label key={box.key} className="stack" style={{ gap: 4 }}>
                      <span>{box.label}</span>
                      {box.hint && <span className="muted" style={{ fontSize: "0.85em" }}>{box.hint}</span>}
                      <textarea
                        rows={box.rows}
                        maxLength={MANUAL_LIMITS[box.key]}
                        value={manual[box.key] ?? ""}
                        onChange={(e) => setManual({ ...manual, [box.key]: e.target.value })}
                      />
                    </label>
                  ))}
              </>
            )}
          </div>
          <div className="row">
            <button className="primary" disabled={creating || topic.trim().length < 3}>
              {creating ? "Starting…" : format === "carousel" ? "Start carousel" : "Start job"}
            </button>
            <span className="muted">
              {wf.skipApproval ? "Posts as soon as its check passes, with no review from you." : "You approve before anything is posted."}
            </span>
          </div>
          {error && <p className="error">{error}</p>}
        </form>
      </section>

      <section className="card stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Server check</h2>
          <button disabled={checking} onClick={checkServers}>
            {checking ? "Checking…" : "Check servers"}
          </button>
        </div>
        <span className="muted">
          Run this before you start a job. It checks that the Gemini and Instagram servers answer and that their logins still work.
          The Gemini check sends one short question to Gemini.
        </span>
        {health && (
          <div className="stack">
            {health.mode === "mock" && <span className="muted">Mock mode: these results are fixed, no server was contacted.</span>}
            <CheckRow label="Gemini server" result={health.gemini.tools} />
            <CheckRow label="Gemini login" result={health.gemini.session} />
            <CheckRow label="Instagram login" result={health.instagram} />
          </div>
        )}
        {healthError && <p className="error">{healthError}</p>}
      </section>

      <section className="card">
        <h2>Jobs</h2>
        {jobs.length === 0 ? (
          <p className="muted">No jobs yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Topic</th>
                <th>Status</th>
                <th>Generation</th>
                <th>Starts</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>
                    <a className="rowlink" href={`/jobs/${j.id}`}>
                      {j.topic}
                    </a>
                    {j.format === "carousel" && <span className="badge" style={{ marginLeft: 8 }}>Carousel</span>}
                    {j.research === "quick" && <span className="badge" style={{ marginLeft: 8 }}>Quick check</span>}
                  </td>
                  <td>
                    <span className={`badge ${TONE[j.state] ?? ""}`}>{STATE_LABEL[j.state]}</span>
                  </td>
                  <td>{j.attempts}</td>
                  <td className="muted">
                    {new Date(j.scheduled_at) > new Date() ? new Date(j.scheduled_at).toLocaleString() : "Now"}
                  </td>
                  <td className="muted">{new Date(j.updated_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
