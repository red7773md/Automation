import { loadCookie } from "@/lib/secrets";
import { createChatGpt, createGemini } from "./ai-mcp";
import { chatgpt as chatgptBridge, gemini as geminiBridge } from "./bridge";
import { instagram } from "./instagram-mcp";
import { mockProviders } from "./mock";
import type { Providers, Transport } from "./types";

export * from "./types";

const geminiMcp = createGemini({
  url: () => process.env.GEMINI_MCP_URL,
  toolMap: () => process.env.GEMINI_TOOL_MAP,
  cookie: loadCookie,
});
const chatgptMcp = createChatGpt({
  url: () => process.env.CHATGPT_MCP_URL,
  toolMap: () => process.env.CHATGPT_TOOL_MAP,
  cookie: loadCookie,
});

const NOT_SET_GEMINI = "Set GEMINI_MCP_URL or GEMINI_BRIDGE_URL in the Vercel environment variables.";
const NOT_SET_CHATGPT = "Set CHATGPT_MCP_URL or CHATGPT_BRIDGE_URL in the Vercel environment variables.";

const missingGemini: Providers["gemini"] = {
  health: async () => ({ ok: false, message: NOT_SET_GEMINI }),
  session: async () => ({ ok: false, message: NOT_SET_GEMINI }),
  models: async () => ({ models: [], verifiedAt: null, message: NOT_SET_GEMINI }),
  startResearch: async () => { throw new Error(NOT_SET_GEMINI); },
  pollResearch: async () => { throw new Error(NOT_SET_GEMINI); },
  analyze: async () => { throw new Error(NOT_SET_GEMINI); },
  analyzeCarousel: async () => { throw new Error(NOT_SET_GEMINI); },
  search: async () => { throw new Error(NOT_SET_GEMINI); },
  confirm: async () => { throw new Error(NOT_SET_GEMINI); },
  caption: async () => { throw new Error(NOT_SET_GEMINI); },
  verifyImage: async () => { throw new Error(NOT_SET_GEMINI); },
  generateImage: async () => { throw new Error(NOT_SET_GEMINI); },
};

const missingChatgpt: Providers["chatgpt"] = {
  health: async () => ({ ok: false, message: NOT_SET_CHATGPT }),
  generateImage: async () => { throw new Error(NOT_SET_CHATGPT); },
};

/** Which transport each provider uses. MCP wins when both URLs are set. */
export function transports(): { gemini: Transport; chatgpt: Transport; instagram: boolean } {
  return {
    gemini: process.env.GEMINI_MCP_URL ? "mcp" : process.env.GEMINI_BRIDGE_URL ? "bridge" : "none",
    chatgpt: process.env.CHATGPT_MCP_URL ? "mcp" : process.env.CHATGPT_BRIDGE_URL ? "bridge" : "none",
    instagram: !!process.env.INSTAGRAM_MCP_URL,
  };
}

/** PROVIDER_MODE=live uses the real transports. Anything else uses the mock, which calls nothing. */
export function providers(): Providers {
  if (process.env.PROVIDER_MODE !== "live") return mockProviders;
  const t = transports();
  return {
    mode: "live",
    gemini: t.gemini === "mcp" ? geminiMcp : t.gemini === "bridge" ? geminiBridge : missingGemini,
    chatgpt: t.chatgpt === "mcp" ? chatgptMcp : t.chatgpt === "bridge" ? chatgptBridge : missingChatgpt,
    instagram,
  };
}
