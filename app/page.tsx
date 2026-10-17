"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "@/lib/client";
import { STATE_LABEL, type State } from "@/lib/jobs/states";

type JobSummary = {
  id: string;
  topic: string;
  state: State;
  attempts: number;
  error: string | null;
  busy: boolean;
  scheduled_at: string;
  updated_at: string;
};
type Status = {
  mode: "mock" | "live";
  transports: { gemini: string; chatgpt: string; instagram: boolean };
  imageProvider: string;
  gemini: { configured: boolean };
  chatgpt: { configured: boolean };
};

const TONE: Partial<Record<State, string>> = { awaiting_review: "warn", done: "ok", failed: "bad" };

export default function Dashboard() {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [startAt, setStartAt] = useState(""); // local date and time from the picker; empty means now

  const load = useCallback(
    () =>
      api<{ jobs: JobSummary[] }>("GET", "/api/jobs")
        .then((d) => setJobs(d.jobs))
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    api<Status>("GET", "/api/providers").then(setStatus).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const body: { topic: string; scheduledAt?: string } = { topic };
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
          <label className="stack">
            <span className="muted">Start at (optional, your local time). Leave empty to start now.</span>
            <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
          </label>
          <div className="row">
            <button className="primary" disabled={creating || topic.trim().length < 3}>
              {creating ? "Starting…" : "Start job"}
            </button>
            <span className="muted">Research, planning, image and checks run one step at a time. You approve before anything is posted.</span>
          </div>
          {error && <p className="error">{error}</p>}
        </form>
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
