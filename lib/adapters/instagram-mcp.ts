// Instagram MCP. Tool names and argument names come from the published schema of
// the Instagram connector (instagram_post_photo, instagram_comment_on_post, instagram_pin_comment).
import { withMcp, type McpClient, type McpTool } from "./mcp";
import { findValue, parseJsonSafe } from "./parse";
import type { Providers, ToolSummary } from "./types";

const NAME = {
  post: "instagram_post_photo",
  comment: "instagram_comment_on_post",
  pin: "instagram_pin_comment",
} as const;

function endpoint(): string {
  const url = process.env.INSTAGRAM_MCP_URL;
  if (!url) throw new Error("INSTAGRAM_MCP_URL is not set");
  return url;
}

function requireTool(tools: McpTool[], name: string): void {
  if (!tools.some((t) => t.name === name)) {
    throw new Error(`Instagram MCP has no tool "${name}". Server tools: ${tools.map((t) => t.name).join(", ") || "(none)"}`);
  }
}

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  return withMcp(endpoint(), {}, async (client: McpClient) => {
    requireTool(await client.listTools(), name);
    const result = await client.call(name, args);
    if (result.isError) throw new Error(`${name} returned an error: ${result.text.slice(0, 500)}`);
    return result.text;
  });
}

function idFrom(text: string, keys: string[], what: string): string {
  const fromJson = findValue(parseJsonSafe(text), keys);
  if (fromJson) return fromJson;
  const digits = text.match(/\b\d{8,}\b/);
  if (digits) return digits[0];
  throw new Error(`Could not read the ${what} id from the Instagram MCP reply: ${text.slice(0, 300)}`);
}

export const instagram: Providers["instagram"] = {
  async listTools(): Promise<ToolSummary[]> {
    return withMcp(endpoint(), {}, async (client) =>
      (await client.listTools()).map((t) => ({
        name: t.name,
        args: Object.keys(t.inputSchema?.properties ?? {}),
        required: t.inputSchema?.required ?? [],
      })),
    );
  },

  async postPhoto({ imageUrl, caption }) {
    // The draft is a square 1024px image, so "square" gives the exact 1:1 feed frame.
    const raw = await call(NAME.post, {
      caption,
      image_path_or_url: imageUrl,
      aspect: "square",
      disable_comments: false,
      dry_run: false,
    });
    return { mediaId: idFrom(raw, ["media_id", "mediaId", "id", "pk"], "media"), raw };
  },

  async comment({ mediaId, text }) {
    const raw = await call(NAME.comment, { media_id_or_url: mediaId, text });
    return { commentId: idFrom(raw, ["comment_id", "commentId", "id", "pk"], "comment"), raw };
  },

  async pin({ commentId, mediaId }) {
    const raw = await call(NAME.pin, { comment_id: commentId, media_id_or_url: mediaId, pin: true });
    return { raw };
  },
};
