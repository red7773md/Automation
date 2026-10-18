// Instagram MCP. Tool and argument names come from red7773md/instagram-mcp-api
// (instagram_mcp_server/mcp_server.py): instagram_post_photo, instagram_comment_on_post,
// instagram_pin_comment.
//
// That server does not answer with JSON. Post and comment return a Python dict as text
// ("{'status': 'success', 'media_id': '179...', ...}"), and errors come back as ordinary
// text ("Error while posting the photo: ...") with isError false. So success is read from
// the text, and anything else is an error.
import { withMcp, type McpClient, type McpTool } from "./mcp";
import type { Providers, ToolSummary } from "./types";

const NAME = {
  post: "instagram_post_photo",
  comment: "instagram_comment_on_post",
  pin: "instagram_pin_comment",
  login: "instagram_get_login_status",
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

/** One value from a reply: a Python dict ('key': 'value') or JSON ("key": "value"). */
export function field(text: string, key: string): string | undefined {
  const m = text.match(new RegExp(`['"]${key}['"]\\s*:\\s*['"]?([^'",}\\s]+)`));
  return m?.[1];
}

function isSuccess(text: string): boolean {
  return field(text, "status") === "success";
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
    if (!isSuccess(raw)) throw new Error(`Instagram did not post the photo: ${raw.slice(0, 400)}`);
    const mediaId = field(raw, "media_id");
    if (!mediaId) throw new Error(`Instagram reported success but gave no media id: ${raw.slice(0, 300)}`);
    return { mediaId, raw };
  },

  async comment({ mediaId, text }) {
    const raw = await call(NAME.comment, { media_id_or_url: mediaId, text });
    if (!isSuccess(raw)) throw new Error(`Instagram did not post the comment: ${raw.slice(0, 400)}`);
    const commentId = field(raw, "comment_id");
    if (!commentId) throw new Error(`Instagram reported success but gave no comment id: ${raw.slice(0, 300)}`);
    return { commentId, raw };
  },

  async pin({ commentId, mediaId }) {
    const raw = await call(NAME.pin, { comment_id: commentId, media_id_or_url: mediaId, pin: true });
    // Success reads "Comment <id> pinned on post <id> (paced Ns)." An unpin reads "unpinned", so anchor on the start.
    if (!/^Comment \S+ pinned on post /.test(raw.trim())) {
      throw new Error(`Instagram did not pin the comment: ${raw.slice(0, 400)}`);
    }
    return { raw };
  },

  async status() {
    // The server replies with a Python dict: {'logged_in': True, 'username': 'name', 'user_id': '...'}.
    const raw = await call(NAME.login, {});
    if (field(raw, "logged_in") !== "True") {
      return {
        ok: false,
        message: "Not logged in. The Instagram session has expired or was never set up. Log in again on the Instagram server.",
      };
    }
    const username = field(raw, "username");
    return { ok: true, message: `Logged in${username && username !== "None" ? ` as ${username}` : ""}`, username };
  },
};
