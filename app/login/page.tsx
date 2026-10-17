"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api } from "@/lib/client";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/api/login", { username, password });
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <section className="card login">
      <h2>Sign in</h2>
      <form onSubmit={submit} className="stack">
        <input type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" />
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
        <button className="primary" disabled={busy || !username || !password}>
          {busy ? "Checking…" : "Sign in"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </section>
  );
}
