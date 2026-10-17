// HTTP bridges for Gemini and ChatGPT. Each bridge is a small service you run
// (or adapt from an unofficial wrapper). The app sends the saved cookie in the
// x-provider-cookie header on every call, so the bridge keeps no secrets.
// Contract: see README.md, section "Bridge contract".
import { LABEL, loadCookie, type Provider } from "@/lib/secrets";
import type { Health, Providers, ResearchPoll, Verdict } from "./types";

function bridgeUrl(provider: Provider, path: string): string {
  const envName = provider === "gemini" ? "GEMINI_BRIDGE_URL" : "CHATGPT_BRIDGE_URL";
  const raw = process.env[envName];
  if (!raw) throw new Error(`${envName} is not set`);
  const url = new URL(raw); // keeps any ?auth=... query the bridge needs
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  return url.toString();
}

async function call<T>(
  provider: Provider,
  method: "GET" | "POST",
  path: string,
  timeoutMs: number,
  body?: unknown,
): Promise<T> {
  const cookie = await loadCookie(provider);
  if (!cookie) throw new Error(`${LABEL[provider]} cookies are not set. Add them in Settings.`);

  const res = await fetch(bridgeUrl(provider, path), {
    method,
    headers: { "content-type": "application/json", "x-provider-cookie": cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 300) };
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `${LABEL[provider]} bridge rejected the request (HTTP ${res.status}). The cookies have probably expired, or the bridge URL key is wrong. Replace the cookies in Settings or check the bridge.`,
    );
  }
  if (!res.ok) {
    throw new Error(`${LABEL[provider]} bridge ${path} returned HTTP ${res.status}: ${data.error ?? data.raw ?? "(no message)"}`);
  }
  return data as T;
}

export const gemini: Providers["gemini"] = {
  generateImage: async () => {
    throw new Error("The Gemini HTTP bridge does not generate images yet. Use GEMINI_MCP_URL for images.");
  },
  health: () => call<Health>("gemini", "GET", "/health", 20_000),
  startResearch: (topic) => call<{ ref: string }>("gemini", "POST", "/research/start", 30_000, { topic }),
  pollResearch: (ref) => call<ResearchPoll>("gemini", "POST", "/research/poll", 30_000, { ref }),
  analyze: async () => {
    throw new Error("The Gemini HTTP bridge does not do analysis yet. Use GEMINI_MCP_URL.");
  },
  caption: async () => {
    throw new Error("The Gemini HTTP bridge does not write captions yet. Use GEMINI_MCP_URL.");
  },
  verifyImage: async ({ topic, imagePrompt, image, mimeType, attempt }) => {
    const v = await call<Partial<Verdict>>("gemini", "POST", "/verify", 150_000, {
      topic,
      imagePrompt,
      attempt,
      image: { mimeType, base64: image.toString("base64") },
    });
    return {
      pass: v.pass === true,
      issues: Array.isArray(v.issues) ? v.issues.map(String) : [],
      revisedPrompt: typeof v.revisedPrompt === "string" && v.revisedPrompt.trim() ? v.revisedPrompt.trim() : undefined,
    };
  },
};

export const chatgpt: Providers["chatgpt"] = {
  health: () => call<Health>("chatgpt", "GET", "/health", 20_000),
  generateImage: async (prompt) => {
    const r = await call<{ base64: string; mimeType?: string }>("chatgpt", "POST", "/image", 240_000, {
      prompt,
      size: "1024x1024",
      format: "jpeg", // Instagram publishing expects JPEG
    });
    return { bytes: Buffer.from(r.base64, "base64"), mimeType: r.mimeType || "image/jpeg" };
  },
};
