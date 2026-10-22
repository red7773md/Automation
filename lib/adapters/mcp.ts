// Minimal MCP client over the Streamable HTTP transport. Each withMcp() call opens
// its own session, runs its requests, and drops the session. Nothing is kept
// between calls, which suits serverless hosting.

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
};

export type McpCallResult = { text: string; blocks: Array<Record<string, any>>; isError: boolean };

const PROTOCOL_VERSION = "2025-03-26";

export class McpClient {
  private sessionId?: string;
  private nextId = 2;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {}

  private async post(body: Record<string, unknown>, timeoutMs = 120_000): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`MCP server returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return res;
  }

  private async message(res: Response, id: number): Promise<any> {
    const text = await res.text();
    if (!text.trim()) return null;
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const msg = JSON.parse(line.slice(5).trim());
        if (msg.id === id) return msg;
      }
      throw new Error("MCP event stream ended without a response");
    }
    return JSON.parse(text);
  }

  async open(): Promise<void> {
    const init = await this.post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "insta-agent", version: "1.0.0" } },
    });
    this.sessionId = init.headers.get("mcp-session-id") ?? undefined;
    const msg = await this.message(init, 1);
    if (msg?.error) throw new Error(`MCP initialize failed: ${JSON.stringify(msg.error)}`);
    await (await this.post({ jsonrpc: "2.0", method: "notifications/initialized" })).text();
  }

  private async rpc(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<any> {
    const id = this.nextId++;
    const msg = await this.message(await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs), id);
    if (msg?.error) throw new Error(`MCP ${method} failed: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    return msg?.result;
  }

  async listTools(): Promise<McpTool[]> {
    return (await this.rpc("tools/list"))?.tools ?? [];
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<McpCallResult> {
    const result = await this.rpc("tools/call", { name, arguments: args }, timeoutMs);
    const blocks: Array<Record<string, any>> = result?.content ?? [];
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => String(b.text))
      .join("\n");
    return { text, blocks, isError: result?.isError === true };
  }
}

/**
 * Makes a server URL safe to call. A key pasted raw into a URL can contain # & + %, which
 * a URL parser reads as fragment, separator or escape. The value after "name=" is encoded
 * unless it is already a valid encoded value.
 */
export function normalizeServerUrl(raw: string): string {
  const q = raw.indexOf("?");
  if (q === -1) return raw;
  const base = raw.slice(0, q);
  const query = raw.slice(q + 1);
  const eq = query.indexOf("=");
  if (eq <= 0) return raw;
  const name = query.slice(0, eq);
  const value = query.slice(eq + 1);
  let alreadyEncoded = false;
  try {
    alreadyEncoded = encodeURIComponent(decodeURIComponent(value)) === value;
  } catch {
    alreadyEncoded = false; // stray % signs: treat the value as raw
  }
  return alreadyEncoded ? raw : `${base}?${name}=${encodeURIComponent(value)}`;
}

export async function withMcp<T>(
  url: string,
  headers: Record<string, string>,
  fn: (client: McpClient) => Promise<T>,
): Promise<T> {
  const client = new McpClient(normalizeServerUrl(url), headers);
  await client.open();
  return fn(client);
}
