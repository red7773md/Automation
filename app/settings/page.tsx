"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";

type Meta = { configured: boolean; updatedAt: string | null; cookieNames: string[] };
type Transport = "mcp" | "bridge" | "none";
type Status = {
  mode: "mock" | "live";
  transports: { gemini: Transport; chatgpt: Transport; instagram: boolean };
  imageProvider: "gemini" | "chatgpt";
  gemini: Meta;
  chatgpt: Meta;
  instagram: { configured: boolean };
  publicUrl: boolean;
};
type Note = { ok: boolean; text: string };
type Health = { ok: boolean; message: string; details?: { mapping?: Record<string, string>; serverTools?: string[] } };

const TRANSPORT_LABEL: Record<Transport, string> = { mcp: "MCP server", bridge: "HTTP bridge", none: "Not configured" };
const TRANSPORT_TONE: Record<Transport, string> = { mcp: "ok", bridge: "ok", none: "warn" };

export default function SettingsPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () => api<Status>("GET", "/api/providers").then(setStatus).catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  if (!status) return <section className="card">{error ?? <span className="muted">Loading…</span>}</section>;

  return (
    <>
      <section className="card stack">
        <h2 style={{ margin: 0 }}>Connections</h2>
        <div className="row">
          <span className={`badge ${status.mode === "live" ? "ok" : "warn"}`}>
            {status.mode === "live" ? "LIVE" : "MOCK (nothing external is called)"}
          </span>
          {!status.publicUrl && <span className="badge bad">PUBLIC_APP_URL not set</span>}
        </div>
        <div className="grid3">
          <Chip label="Gemini" tone={TRANSPORT_TONE[status.transports.gemini]} text={TRANSPORT_LABEL[status.transports.gemini]} />
          {status.imageProvider === "chatgpt" && (
            <Chip label="ChatGPT" tone={TRANSPORT_TONE[status.transports.chatgpt]} text={TRANSPORT_LABEL[status.transports.chatgpt]} />
          )}
          <Chip label="Instagram" tone={status.instagram.configured ? "ok" : "warn"} text={status.instagram.configured ? "MCP server" : "INSTAGRAM_MCP_URL missing"} />
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Server URLs live in Vercel environment variables. Cookies are saved here, encrypted in the database.
        </p>
      </section>

      <CookieCard provider="gemini" label="Gemini" meta={status.gemini} transport={status.transports.gemini} onChange={load} />
      {status.imageProvider === "chatgpt" && (
        <CookieCard provider="chatgpt" label="ChatGPT" meta={status.chatgpt} transport={status.transports.chatgpt} onChange={load} />
      )}
      <ModelsCard />
      <InstagramCard configured={status.instagram.configured} />
    </>
  );
}

function Chip({ label, tone, text }: { label: string; tone: string; text: string }) {
  return (
    <div className="chip">
      <span className="muted">{label}</span>
      <span className={`badge ${tone}`}>{text}</span>
    </div>
  );
}

function CookieCard({
  provider,
  label,
  meta,
  transport,
  onChange,
}: {
  provider: "gemini" | "chatgpt";
  label: string;
  meta: Meta;
  transport: Transport;
  onChange: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [mapping, setMapping] = useState<Record<string, string> | null>(null);

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      await api("PUT", `/api/providers/${provider}`, { cookie: value });
      setValue("");
      setNote({ ok: true, text: `${label} cookies saved (encrypted).` });
      onChange();
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setNote(null);
    setMapping(null);
    try {
      const r = await api<Health>("POST", `/api/providers/${provider}/test`);
      setNote({ ok: r.ok, text: r.message });
      setMapping(r.details?.mapping ?? null);
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Remove the saved ${label} cookies?`)) return;
    setBusy(true);
    try {
      await api("DELETE", `/api/providers/${provider}`);
      setNote({ ok: true, text: `${label} cookies removed.` });
      onChange();
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>{label}</h2>
        <div className="row">
          <span className={`badge ${TRANSPORT_TONE[transport]}`}>{TRANSPORT_LABEL[transport]}</span>
          <span className={`badge ${meta.configured ? "ok" : "warn"}`}>{meta.configured ? "Cookies saved" : "No cookies"}</span>
        </div>
      </div>

      {meta.configured && meta.updatedAt && (
        <p className="muted" style={{ margin: 0 }}>
          Updated {new Date(meta.updatedAt).toLocaleString()} · cookie names: {meta.cookieNames.join(", ")}
        </p>
      )}
      {provider === "gemini" && transport === "mcp" && (
        <p className="muted" style={{ margin: 0 }}>
          Optional. Leave this empty if your Gemini MCP server keeps its own session.
        </p>
      )}
      {transport === "none" && (
        <p className="banner">
          Set {provider === "gemini" ? "GEMINI_MCP_URL" : "CHATGPT_MCP_URL"} (or a bridge URL) in Vercel before going live.
        </p>
      )}

      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Paste the full Cookie header: name=value; name2=value2"
      />
      <div className="row">
        <button className="primary" disabled={busy || !value.trim()} onClick={save}>
          Save cookies
        </button>
        <button disabled={busy || transport === "none"} onClick={test}>
          Test connection
        </button>
        <button className="danger" disabled={busy || !meta.configured} onClick={remove}>
          Remove
        </button>
      </div>

      {note && <p className={note.ok ? "muted" : "error"} style={{ margin: 0 }}>{note.text}</p>}
      {mapping && (
        <div className="stack">
          <span className="muted">Tool matched to each operation</span>
          <pre className="block">{Object.entries(mapping).map(([op, tool]) => `${op.padEnd(14)} → ${tool}`).join("\n")}</pre>
          <span className="muted">
            If a match is wrong, set {provider === "gemini" ? "GEMINI_TOOL_MAP" : "CHATGPT_TOOL_MAP"} in Vercel, for example {`{"plan": "tool_name"}`}.
          </span>
        </div>
      )}
    </section>
  );
}

type ModelMap = Record<string, string>;
type SettingsData = { models: ModelMap; presets: string[]; tasks: { id: string; label: string; hint: string }[] };

function ModelsCard() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [draft, setDraft] = useState<ModelMap>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  useEffect(() => {
    api<SettingsData>("GET", "/api/settings")
      .then((d) => {
        setData(d);
        setDraft(d.models);
      })
      .catch((e) => setNote({ ok: false, text: e instanceof Error ? e.message : String(e) }));
  }, []);

  async function save(models: ModelMap) {
    setBusy(true);
    setNote(null);
    try {
      const r = await api<{ models: ModelMap }>("PUT", "/api/settings", { models });
      setDraft(r.models);
      setData((prev) => (prev ? { ...prev, models: r.models } : prev));
      setNote({ ok: true, text: "Models saved. Each step uses them from its next run." });
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <section className="card">{note ? <p className="error">{note.text}</p> : <span className="muted">Loading models…</span>}</section>;

  const changed = data.tasks.some((t) => (draft[t.id] ?? "") !== (data.models[t.id] ?? ""));

  return (
    <section className="card stack">
      <h2 style={{ margin: 0 }}>Gemini models per task</h2>
      <p className="muted" style={{ margin: 0 }}>
        Leave a field empty to use the account default. Names are the library&apos;s model names, such as gemini-pro or gemini-flash.
        Advanced and Plus models need an account that has them.
      </p>
      <datalist id="model-presets">
        {data.presets.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      {data.tasks.map((t) => (
        <label key={t.id} className="stack" style={{ gap: 4 }}>
          <span>{t.label}</span>
          <span className="muted" style={{ fontSize: "0.85em" }}>{t.hint}</span>
          <input
            type="text"
            list="model-presets"
            placeholder="account default"
            value={draft[t.id] ?? ""}
            maxLength={64}
            onChange={(e) => setDraft({ ...draft, [t.id]: e.target.value })}
          />
        </label>
      ))}
      <div className="row">
        <button className="primary" disabled={busy || !changed} onClick={() => save(draft)}>
          Save models
        </button>
        <button disabled={busy} onClick={() => save(Object.fromEntries(data.tasks.map((t) => [t.id, ""])))}>
          Use account default for all
        </button>
      </div>
      {note && <p className={note.ok ? "muted" : "error"} style={{ margin: 0 }}>{note.text}</p>}
    </section>
  );
}

function InstagramCard({ configured }: { configured: boolean }) {
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function test() {
    setBusy(true);
    setError(null);
    setOut(null);
    try {
      const r = await api<{ tools: { name: string; args: string[]; required: string[] }[] }>(
        "POST",
        "/api/providers/instagram/test",
      );
      setOut(
        r.tools
          .map((t) => `${t.name}\n   arguments: ${t.args.join(", ") || "(none)"}\n   required:  ${t.required.join(", ") || "(none)"}`)
          .join("\n\n"),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Instagram</h2>
        <span className={`badge ${configured ? "ok" : "warn"}`}>{configured ? "MCP configured" : "INSTAGRAM_MCP_URL missing"}</span>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        The URL and its key are in Vercel. Test connection lists the server's tools and the arguments the app sends.
      </p>
      <div className="row">
        <button disabled={busy || !configured} onClick={test}>
          {busy ? "Testing…" : "Test connection"}
        </button>
      </div>
      {out && <pre className="block">{out}</pre>}
      {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
    </section>
  );
}
