// Gemini and ChatGPT through MCP servers. Their tool names are not fixed, so each
// operation is matched to a tool by name, description and input schema. The
// match is logged and shown in Settings. GEMINI_TOOL_MAP / CHATGPT_TOOL_MAP
// (JSON, operation -> tool name) overrides it when it picks the wrong tool.
import { LABEL, type Provider } from "@/lib/secrets";
import { withMcp, type McpCallResult, type McpClient, type McpTool } from "./mcp";
import { extractJson, findValue, parseJsonSafe } from "./parse";
import { ANALYZE_PROMPT, CAPTION_PROMPT, REPORT_ATTACHED, REPORT_FILE, VERIFY_PROMPT, fill } from "./prompts";
import type { Analysis, Caption, Health, Providers, ResearchPoll, Verdict } from "./types";

export type Op = "startResearch" | "pollResearch" | "analyze" | "caption" | "verifyImage" | "generateImage";
export type ArgKeys = { prompt?: string; ref?: string; image?: string; cookie?: string; model?: string; attachments?: string };
/** A text file sent with a question. The Gemini server writes it under this name. */
export type Attachment = { name: string; content_base64: string };
export type OpPlan = { tool: string; keys: ArgKeys };
export type Resolution = Partial<Record<Op, OpPlan>>;

export const REQUIRED_OPS: Record<Provider, Op[]> = {
  gemini: ["startResearch", "pollResearch", "analyze", "caption", "verifyImage", "generateImage"],
  chatgpt: ["generateImage"],
};

export type McpOptions = {
  url: () => string | undefined; // read on every call, so env changes apply without a redeploy of code
  toolMap: () => string | undefined; // optional JSON: {"operation": "tool_name"}
  cookie: (provider: Provider) => Promise<string | null>;
};

const REF_KEYS = ["ref", "chat_id", "chatId", "conversation_id", "conversationId", "research_id", "researchId", "task_id", "taskId", "cid", "id"];
const RUNNING = /running|in[ _-]progress|pending|processing|queued|still|not (yet )?(ready|complete|finished)/i;

function pick(list: string[], patterns: RegExp[]): string | undefined {
  for (const p of patterns) {
    const hit = list.find((k) => p.test(k));
    if (hit) return hit;
  }
  return undefined;
}

/** Which argument names a tool takes for prompt, reference id, image and cookie. */
export function keysOf(tool: McpTool): ArgKeys {
  const all = Object.keys(tool.inputSchema?.properties ?? {});
  const noPaths = all.filter((k) => !/path|url|uri|link/i.test(k));
  return {
    prompt: pick(all, [/^(prompt|message|query|question|input|text|topic|instruction)$/i, /prompt|message|query|question|topic/i]),
    ref: pick(all, [/^(ref|research_?id|chat_?id|conversation_?id|task_?id|cid|id)$/i, /research|chat|conversation|task|ref/i]),
    image: pick(noPaths, [/^(image|image_?base64|base64|image_?data|file|picture|media)$/i, /image|base64|file|picture|media/i]),
    cookie: pick(all, [/cookie/i]),
    model: pick(all, [/^model$/i, /model/i]),
    attachments: pick(all, [/^(attachments|files)$/i]),
  };
}

/** How well a tool fits an operation. 0 means it does not fit at all. */
function score(op: Op, tool: McpTool, keys: ArgKeys): number {
  const full = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
  const name = tool.name.toLowerCase();
  const has = (re: RegExp, s: string) => re.test(s);
  switch (op) {
    case "startResearch":
      if (!keys.prompt || !has(/research/, full)) return 0;
      return 5 + (has(/start|create|begin|launch|run|new|request/, name) ? 3 : 0) - (has(/poll|status|check|result|progress|fetch|get/, name) ? 6 : 0);
    case "pollResearch":
      if (!keys.ref || !has(/research/, full)) return 0;
      return 5 + (has(/status|poll|check|result|progress|fetch|get/, name) ? 3 : 0) - (has(/start|create|begin|launch/, name) ? 6 : 0);
    case "analyze":
    case "caption":
      if (!keys.prompt || has(/image|picture|photo|draw|research|vision|analy/, full)) return 0;
      return 5 + (has(/chat|ask|generate|send|prompt|message|text/, full) ? 3 : 0);
    case "verifyImage":
      if (!keys.image || !keys.prompt) return 0;
      return 5 + (has(/analy|vision|verify|check|describe|review|inspect|look|understand|image/, full) ? 3 : 0);
    case "generateImage":
      if (!keys.prompt || has(/analy|describe|verify|vision|understand|review/, full)) return 0;
      return has(/image|picture|photo|draw|render/, full) && has(/generate|create|make|draw|render|dall|imag/, full)
        ? 5 + (has(/image/, name) ? 3 : 0)
        : 0;
  }
}

export function parseToolMap(raw: string | undefined): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('TOOL_MAP must be JSON such as {"plan": "my_chat_tool"}');
  }
  if (!parsed || typeof parsed !== "object") throw new Error("TOOL_MAP must be a JSON object");
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
}

export function resolve(
  provider: Provider,
  tools: McpTool[],
  toolMap: Record<string, string> = {},
): { map: Resolution; missing: Op[] } {
  const map: Resolution = {};
  for (const op of REQUIRED_OPS[provider]) {
    const forced = toolMap[op];
    if (forced) {
      const tool = tools.find((t) => t.name === forced);
      if (tool) map[op] = { tool: tool.name, keys: keysOf(tool) };
      continue; // a forced name that the server does not have is reported as missing
    }
    let best: { tool: McpTool; s: number } | undefined;
    for (const tool of tools) {
      const s = score(op, tool, keysOf(tool));
      if (s > 0 && (!best || s > best.s)) best = { tool, s };
    }
    if (best) map[op] = { tool: best.tool.name, keys: keysOf(best.tool) };
  }
  return { map, missing: REQUIRED_OPS[provider].filter((op) => !map[op]) };
}

function makeRunner(provider: Provider, opts: McpOptions) {
  const label = LABEL[provider];
  const envPrefix = provider.toUpperCase();

  function endpoint(): string {
    const url = opts.url();
    if (!url) throw new Error(`${envPrefix}_MCP_URL is not set`);
    return url;
  }

  async function run<T>(op: Op, fn: (client: McpClient, route: OpPlan, cookie: string) => Promise<T>): Promise<T> {
    // Cookies are optional: a server that keeps its own Gemini session needs none.
    const cookie = (await opts.cookie(provider)) ?? "";
    const headers: Record<string, string> = cookie ? { "x-provider-cookie": cookie } : {};
    return withMcp(endpoint(), headers, async (client) => {
      const tools = await client.listTools();
      const { map } = resolve(provider, tools, parseToolMap(opts.toolMap()));
      const route = map[op];
      if (!route) {
        const names = tools.map((t) => t.name).join(", ") || "(none)";
        throw new Error(
          `${label} MCP: no tool matches "${op}". Set ${envPrefix}_TOOL_MAP to the right tool name, or send me the tool list. Server tools: ${names}`,
        );
      }
      return fn(client, route, cookie);
    });
  }

  async function call(
    client: McpClient,
    route: OpPlan,
    values: { prompt?: string; ref?: string; image?: string; model?: string; attachments?: Attachment[] },
    cookie: string,
  ): Promise<McpCallResult> {
    const args: Record<string, unknown> = {};
    if (route.keys.prompt && values.prompt !== undefined) args[route.keys.prompt] = values.prompt;
    if (route.keys.ref && values.ref !== undefined) args[route.keys.ref] = values.ref;
    if (route.keys.image && values.image !== undefined) args[route.keys.image] = values.image;
    // Only sent when the tool takes a model argument and a model is chosen. Otherwise the server's default applies.
    if (route.keys.model && values.model) args[route.keys.model] = values.model;
    // Only sent when the tool takes attachments. Callers check route.keys.attachments before they build one.
    if (route.keys.attachments && values.attachments?.length) args[route.keys.attachments] = values.attachments;
    if (route.keys.cookie && cookie) args[route.keys.cookie] = cookie;
    const result = await client.call(route.tool, args);
    if (result.isError) throw new Error(`${route.tool} returned an error: ${result.text.slice(0, 500)}`);
    return result;
  }

  async function health(): Promise<Health> {
    try {
      return await withMcp(endpoint(), {}, async (client) => {
        const tools = await client.listTools();
        const { map, missing } = resolve(provider, tools, parseToolMap(opts.toolMap()));
        const mapping: Record<string, string> = {};
        for (const op of REQUIRED_OPS[provider]) {
          const route = map[op];
          if (route) mapping[op] = `${route.tool} (args: ${Object.values(route.keys).filter(Boolean).join(", ") || "none"})`;
        }
        if (missing.length) {
          return {
            ok: false,
            message: `No tool found for: ${missing.join(", ")}. Set ${envPrefix}_TOOL_MAP or send me the tool list.`,
            details: { mapping, serverTools: tools.map((t) => t.name) },
          };
        }
        return { ok: true, message: `Connected. ${REQUIRED_OPS[provider].length} operation(s) mapped.`, details: { mapping } };
      });
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  return { run, call, health };
}

/** Turns a research poll reply into running / done / failed. Works with JSON or plain text replies. */
export function interpretPoll(text: string): ResearchPoll {
  const data = parseJsonSafe(text);
  if (data && typeof data === "object") {
    const rec = data as Record<string, unknown>;
    const status = String(rec.status ?? rec.state ?? "").toLowerCase();
    const report = ["report", "markdown", "content", "text", "result"]
      .map((k) => rec[k])
      .find((v): v is string => typeof v === "string" && v.trim().length > 0);
    if (/fail|error/.test(status)) return { status: "failed", error: String(rec.error ?? rec.message ?? status) };
    if (RUNNING.test(status)) return { status: "running", progress: status };
    if (/done|complete|finish|ready|success/.test(status)) {
      return report ? { status: "done", report } : { status: "failed", error: "Gemini marked the research done but returned no report" };
    }
    if (!status && report) return { status: "done", report };
    return { status: "running", progress: status || "waiting for Gemini" };
  }
  if (RUNNING.test(text)) return { status: "running", progress: text.trim().slice(0, 120) };
  if (text.trim().length > 300) return { status: "done", report: text };
  return { status: "running", progress: text.trim().slice(0, 120) || "no content yet" };
}

function normalizeVerdict(d: Record<string, any>): Verdict {
  const issues = Array.isArray(d.issues) ? d.issues.map(String) : d.issues ? [String(d.issues)] : [];
  const revised = typeof d.revisedPrompt === "string" && d.revisedPrompt.trim() ? d.revisedPrompt.trim() : undefined;
  return { pass: d.pass === true || String(d.pass).toLowerCase() === "true", issues, revisedPrompt: revised };
}

async function extractImage(result: McpCallResult): Promise<{ bytes: Buffer; mimeType: string }> {
  const block = result.blocks.find((b) => b.type === "image" && typeof b.data === "string");
  if (block) return { bytes: Buffer.from(block.data, "base64"), mimeType: String(block.mimeType ?? "image/png") };

  const data = parseJsonSafe(result.text);
  const b64 = findValue(data, ["base64", "image_base64", "b64_json", "image_data"]);
  if (b64) {
    const dataUrl = /^data:([^;]+);base64,/.exec(b64);
    return {
      bytes: Buffer.from(b64.replace(/^data:[^,]+,/, ""), "base64"),
      mimeType: dataUrl ? dataUrl[1] : "image/png",
    };
  }

  const url = findValue(data, ["url", "image_url", "imageUrl"]) ?? result.text.match(/https?:\/\/[^\s"')]+/)?.[0];
  if (url && /^https?:\/\//.test(url)) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Downloading the generated image failed with HTTP ${res.status}`);
    return { bytes: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get("content-type") ?? "image/png" };
  }
  throw new Error(`Could not find an image in the ChatGPT MCP reply: ${result.text.slice(0, 300)}`);
}

export function createGemini(opts: McpOptions): Providers["gemini"] {
  const r = makeRunner("gemini", opts);
  return {
    health: r.health,
    startResearch: (topic, model) =>
      r.run("startResearch", async (client, route, cookie) => {
        const res = await r.call(client, route, { prompt: topic, model }, cookie);
        const data = parseJsonSafe(res.text);
        const trimmed = res.text.trim();
        const ref =
          findValue(data, REF_KEYS) ??
          (typeof data === "string" ? data : undefined) ??
          (trimmed && trimmed.length < 200 && !/\s/.test(trimmed) ? trimmed : undefined);
        if (!ref) throw new Error(`Gemini MCP did not return a research id. Reply: ${res.text.slice(0, 300)}`);
        return { ref };
      }),
    pollResearch: (ref) =>
      r.run("pollResearch", async (client, route, cookie) => {
        const res = await r.call(client, route, { ref }, cookie);
        return interpretPoll(res.text);
      }),
    analyze: ({ topic, report, model }) =>
      r.run("analyze", async (client, route, cookie): Promise<Analysis> => {
        // With a file-taking tool the report goes as a Markdown file, not inside the prompt.
        const attached = Boolean(route.keys.attachments);
        const res = await r.call(
          client,
          route,
          {
            prompt: fill(ANALYZE_PROMPT, { topic, report: attached ? REPORT_ATTACHED : report }),
            model,
            attachments: attached ? [{ name: REPORT_FILE, content_base64: Buffer.from(report, "utf8").toString("base64") }] : undefined,
          },
          cookie,
        );
        const d = extractJson(res.text);
        return {
          analysis: String(d.analysis ?? ""),
          imagePrompt: String(d.imagePrompt ?? ""),
          reportVia: attached ? "attached" : "pasted",
        };
      }),
    caption: ({ topic, analysis, model }) =>
      r.run("caption", async (client, route, cookie): Promise<Caption> => {
        const res = await r.call(client, route, { prompt: fill(CAPTION_PROMPT, { topic, analysis }), model }, cookie);
        const d = extractJson(res.text);
        return { caption: String(d.caption ?? ""), commentBody: String(d.commentBody ?? "") };
      }),
    verifyImage: ({ topic, imagePrompt, image, model }) =>
      r.run("verifyImage", async (client, route, cookie) => {
        const res = await r.call(
          client,
          route,
          { prompt: fill(VERIFY_PROMPT, { topic, prompt: imagePrompt }), image: image.toString("base64"), model },
          cookie,
        );
        return normalizeVerdict(extractJson(res.text));
      }),
    generateImage: (prompt, model) =>
      r.run("generateImage", async (client, route, cookie) => {
        const res = await r.call(client, route, { prompt, model }, cookie);
        return extractImage(res);
      }),
  };
}

export function createChatGpt(opts: McpOptions): Providers["chatgpt"] {
  const r = makeRunner("chatgpt", opts);
  return {
    health: r.health,
    generateImage: (prompt) =>
      r.run("generateImage", async (client, route, cookie) => {
        const res = await r.call(client, route, { prompt }, cookie);
        return extractImage(res);
      }),
  };
}
