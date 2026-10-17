// A fake MCP server (Streamable HTTP) for tests. It follows the protocol closely
// enough to exercise the real client: sessions, JSON and SSE replies, tool listing,
// tool calls, and an optional access key in the URL.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type FakeTool = {
  name: string;
  description?: string;
  inputSchema: { properties: Record<string, { type: string }>; required?: string[] };
  handle: (args: Record<string, any>) => { text?: string; blocks?: Array<Record<string, unknown>>; isError?: boolean };
};

export type FakeCall = { name: string; args: Record<string, any>; cookie?: string };

export type FakeServer = { url: string; calls: FakeCall[]; close: () => Promise<void> };

export async function startFakeMcp(opts: {
  tools: FakeTool[];
  key?: string;
  sse?: boolean;
  files?: Record<string, { type: string; body: Buffer }>;
}): Promise<FakeServer> {
  const sessionId = "test-session";
  const calls: FakeCall[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && opts.files?.[url.pathname]) {
      const file = opts.files[url.pathname];
      res.writeHead(200, { "content-type": file.type });
      return res.end(file.body);
    }
    if (opts.key && url.searchParams.get("auth") !== opts.key) {
      res.writeHead(401);
      return res.end("invalid key");
    }

    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const msg = JSON.parse(raw || "{}");
      const reply = (id: number, result: unknown) => {
        const payload = JSON.stringify({ jsonrpc: "2.0", id, result });
        if (opts.sse) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          return res.end(`event: message\ndata: ${payload}\n\n`);
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(payload);
      };

      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": sessionId });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: {} } }));
      }
      if (msg.method === "notifications/initialized") {
        res.writeHead(202);
        return res.end();
      }
      if (req.headers["mcp-session-id"] !== sessionId) {
        res.writeHead(400);
        return res.end("missing or wrong session id");
      }
      if (msg.method === "tools/list") {
        return reply(msg.id, {
          tools: opts.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      }
      if (msg.method === "tools/call") {
        const tool = opts.tools.find((t) => t.name === msg.params?.name);
        if (!tool) return reply(msg.id, { content: [{ type: "text", text: "unknown tool" }], isError: true });
        const args = msg.params.arguments ?? {};
        const cookie = req.headers["x-provider-cookie"] as string | undefined;
        calls.push({ name: tool.name, args, cookie });
        const out = tool.handle(args);
        return reply(msg.id, {
          content: out.blocks ?? [{ type: "text", text: out.text ?? "" }],
          isError: out.isError === true,
        });
      }
      if (msg.method === "ping") return reply(msg.id, {});
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
