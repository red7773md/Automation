// Lists the tools an MCP server offers, with their argument names, so the tool
// matching can be checked against the real server. Never prints the key.
//
//   GEMINI_MCP_URL="https://.../mcp?key=..." npm run probe:mcp -- gemini
//   INSTAGRAM_MCP_URL="..." npm run probe:mcp -- instagram
//
// Optional: PROBE_COOKIE="name=value; ..." sends the cookie header as the app does.
import { withMcp } from "../lib/adapters/mcp";

const which = process.argv[2] ?? "gemini";
const envName = which === "instagram" ? "INSTAGRAM_MCP_URL" : which === "chatgpt" ? "CHATGPT_MCP_URL" : "GEMINI_MCP_URL";
const url = process.env[envName];

async function main() {
  if (!url) {
    console.error(`${envName} is not set`);
    process.exit(1);
  }
  const host = url.split("/")[2];
  const headers: Record<string, string> = process.env.PROBE_COOKIE ? { "x-provider-cookie": process.env.PROBE_COOKIE } : {};
  await withMcp(url, headers, async (client) => {
    const tools = await client.listTools();
    console.log(`${tools.length} tool(s) on ${host}\n`);
    for (const t of tools) {
      const props = t.inputSchema?.properties ?? {};
      const required = new Set(t.inputSchema?.required ?? []);
      const args = Object.entries(props).map(([k, v]) => `${k}${required.has(k) ? "*" : ""}: ${v.type ?? "any"}`);
      console.log(t.name);
      console.log(`    ${(t.description ?? "(no description)").split("\n")[0].slice(0, 160)}`);
      console.log(`    args: ${args.join(", ") || "(none)"}`);
    }
    console.log("\n* = required argument");
  });
}

main().catch((err) => {
  console.error("probe failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
