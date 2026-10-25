# Insta Agent

A private web app that turns a topic into an Instagram post. Research and planning run through
Gemini (MCP). You make the pictures yourself (for example in ChatGPT) from the prompts the app
writes, and upload them. Continue publishes through Instagram (MCP), now or at a time you choose.

For a full technical briefing (architecture, file map, pipeline, tool matching, security model),
read `context.md`.

## Run locally

```bash
npm install
cp .env.example .env.local      # fill in the values
npm run dev                     # http://localhost:3000
npm test                        # 21 self-tests, no network needed
```

Create the admin password hash (inside the project, after `npm install`):

```bash
node -e "console.log(require('bcryptjs').hashSync('YOUR-PASSWORD', 12))"
```

Put the output in `ADMIN_PASSWORD_HASH`. In `.env.local`, wrap it in single quotes. In the Vercel
dashboard, paste it without quotes.

Generate the secrets:

```bash
openssl rand -base64 48   # AUTH_SECRET
openssl rand -base64 32   # COOKIE_ENCRYPTION_KEY
```

## Check the Gemini server's tools

```bash
GEMINI_MCP_URL="https://webapi-gray.vercel.app/mcp?key=YOUR_KEY" npm run probe:mcp -- gemini
```

This lists each tool with its argument names. It never prints the key. If the app picks a wrong
tool for an operation, set `GEMINI_TOOL_MAP` (JSON, for example `{"plan": "tool_name"}`).

## Environment variables

| Variable | Purpose |
|---|---|
| `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` | Web UI login |
| `AUTH_SECRET` | Signs sessions and image links (32+ characters) |
| `COOKIE_ENCRYPTION_KEY` | Encrypts saved cookies (base64, 32 bytes) |
| `DATABASE_URL` | Neon Postgres connection string |
| `BLOB_READ_WRITE_TOKEN` | Private Blob store (added by Vercel when connected) |
| `PUBLIC_APP_URL` | `https://your-app.vercel.app`, so Instagram can download images |
| `PROVIDER_MODE` | `mock` (default, nothing external is called) or `live` |
| `GEMINI_MCP_URL` | Gemini MCP server URL, pasted as given (cookies optional) |
| `INSTAGRAM_MCP_URL` | Instagram MCP server URL, with its key |
| `GEMINI_TOOL_MAP`, `CHATGPT_TOOL_MAP` | Optional tool-name overrides (JSON) |
| `CHATGPT_MCP_URL`, `GEMINI_BRIDGE_URL`, `CHATGPT_BRIDGE_URL` | Optional alternatives, not used now |

Cookies are not environment variables. Save them in the Settings page.

## Deploy to Vercel

1. Push this folder to GitHub and import it in Vercel. The project root is this folder.
2. Add **Neon Postgres** from the Vercel Marketplace (sets `DATABASE_URL`).
3. Add a **Blob** store and choose **Private** (sets `BLOB_READ_WRITE_TOKEN`).
4. Set the environment variables above. Mark secrets as Sensitive.
5. Deploy, sign in, and check the Connections panel in Settings.

The advance route asks for `maxDuration = 300` seconds. If your plan rejects that value, lower it
in `app/api/jobs/[id]/advance/route.ts`.

## Using it

1. In Settings, optionally save Gemini cookies (only if your Gemini server needs them). Use a
   secondary account, because web sessions are against Google's terms.
2. Keep `PROVIDER_MODE=mock` and run a job. Nothing is posted.
3. Set `PROVIDER_MODE=live` when the servers are working.

A job runs only while its page is open, except for the scheduled tick. Reopening the page resumes it.
Press Continue only when every picture is one you want published.

## Optional HTTP bridges

`bridges/gemini-bridge` (Vercel) and `bridges/chatgpt-bridge` (your computer) are alternatives to
the MCP servers. Each has its own README.
