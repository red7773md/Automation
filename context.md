# Insta Agent: context for AI assistants

Read this file first. It describes the project so you don't need to read the whole codebase.
Update it whenever the architecture, the status, or the env var names change.
Never add secret values (keys, cookies, tokens, passwords) to this file or to the code.

Last updated: 17 Oct 2026.

## What it does

A private web app for a single admin. The admin enters a topic, and a job turns it into an
Instagram post:

1. **Research** with Gemini (deep research, or a quick search whose facts are checked against their pages)
2. **Analyse** with Gemini: the angle, and one picture described in parts (subject, scene, composition, lighting,
   colours, style, mood, avoid) as JSON. The app builds each picture's prompt from the parts and adds the picture rules
3. **Pictures** are made by hand (for example in ChatGPT) from each prompt, and uploaded on the job page, one per slide
4. **Continue** in the web UI writes the caption, hashtags and pinned comment, then publishes. Or schedule the post for a time
5. **Publish** through the Instagram MCP server: post the photo (or the carousel as one album), post the detailed comment, pin it

## Status (17 Oct 2026)

- Code is complete. `npm test` passes (21 tests, fake MCP servers). `npx tsc --noEmit` passes.
  The production build passes.
- **Not deployed yet.** Blockers: a Neon `DATABASE_URL`, a private Vercel Blob store, the env vars,
  and the go-ahead to deploy.
- **Gemini MCP tool names are not verified.** The server is the Vercel project `webapi`. The app
  matches tools automatically. Run `npm run probe:mcp -- gemini` to list the real tools, then check
  the Settings page mapping. Set `GEMINI_TOOL_MAP` if a match is wrong.
- **Pictures are made by hand.** No job calls an image tool any more, so `IMAGE_PROVIDER` and the Gemini and ChatGPT
  image operations are unused. They remain in the adapters in case they are wanted again.
- **Keys were pasted in chat** (Instagram MCP key, Gemini MCP key). The owner plans to rotate them.
  Whatever key is current must be set only in Vercel env vars.

## Stack

Next.js 15 (App Router, TypeScript), React 19. Neon Postgres through `@neondatabase/serverless`
(tables created automatically on first request). Vercel Blob (private store). `jose` for the admin
session JWT. `bcryptjs` for the admin password hash. Node `crypto`: AES-256-GCM for cookies, HMAC for
media links. Tests run with `tsx`. Hosting: Vercel (Hobby plan).

## Architecture

```
Browser (admin)
  │  pages: dashboard, job view (auto-runs steps while open), settings
  ▼
Next.js API (admin-only, except /api/media)  ──►  Neon Postgres: jobs, job_logs, provider_secrets
  │  advance: runs ONE step under a lock                       (cookies encrypted)
  ▼
Job engine (lib/jobs)  ──►  Providers (lib/adapters/index.ts → Providers interface)
                              ├─ Gemini   → MCP (GEMINI_MCP_URL) or HTTP bridge
                              ├─ ChatGPT  → MCP or HTTP bridge (paused)
                              └─ Instagram→ MCP (INSTAGRAM_MCP_URL)
  Drafts: Vercel Blob, private, path drafts/{jobId}/{attempt}
  Instagram downloads the approved image from /api/media/{jobId}/{attempt}?exp&sig (signed, 30 min)
```

## File map

| Path | Responsibility |
|---|---|
| `middleware.ts` | Login gate for all pages and `/api/*`, except login, logout and `/api/media/*` |
| `app/page.tsx` | Dashboard: start a job, job table, mode banner, readiness check |
| `app/jobs/[id]/page.tsx`, `app/components/JobView.tsx` | Job view: timeline, auto-run loop, review panel, post content, technical log with copy button |
| `app/settings/page.tsx` | Connections panel, Gemini cookie card, ChatGPT card (only if paused in), Instagram test |
| `app/components/Nav.tsx`, `app/layout.tsx`, `app/globals.css` | Navigation, layout, styles |
| `app/api/jobs/*` | List and create jobs, get one job (with logs), `advance` (one step), `review` (approve/reject), `retry`, `draft` (admin image preview) |
| `app/api/providers/*` | Status (`transports`, `imageProvider`), cookie get/save/delete, connection test |
| `app/api/login`, `app/api/logout` | Session cookie `ia_session` |
| `app/api/media/[jobId]/[attempt]` | PUBLIC but signed: the image URL Instagram downloads |
| `lib/jobs/states.ts` | States, `RUNNABLE`, `TIMELINE`, `JobData`/`JobRow` types (safe for the browser) |
| `lib/jobs/picture-prompt.ts` | Picture parts: read from the reply, joined into a prompt, with the picture rules added last |
| `lib/jobs/pictures.ts` | Which pictures are missing, and whether Continue may run (pure) |
| `lib/jobs/steps.ts` | `runStep(job)`: performs ONE step and returns the next state. Plan normalisation (2200-char limit, adds the "see pinned comment" pointer). 45-minute research timeout |
| `lib/jobs/runner.ts` | `advanceJob(id)`: atomic lock (`busy` flag, stale after 6 min), runs one step, writes logs, stores failures with `failedStep` |
| `lib/adapters/types.ts` | `Providers` interface: the contract every adapter implements. Also `Plan`, `Verdict`, `ResearchPoll`, `Health` |
| `lib/adapters/index.ts` | `providers()` picks a transport per provider (MCP, then bridge, then "missing"). Mock when `PROVIDER_MODE` is not `live`. `transports()` |
| `lib/adapters/mcp.ts` | Generic MCP client (Streamable HTTP, JSON and SSE replies, one session per call). `normalizeServerUrl` encodes raw keys |
| `lib/adapters/instagram-mcp.ts` | Instagram operations with the exact tool and argument names (below) |
| `lib/adapters/ai-mcp.ts` | Gemini and ChatGPT over MCP: tool matching (`score`, `keysOf`, `resolve`), `interpretPoll`, `extractImage` |
| `lib/adapters/bridge.ts` | HTTP bridge client (alternative transport). The Gemini bridge has no image operation |
| `lib/adapters/mock.ts` | Mock providers, plus a PNG generator (used for drafts in mock mode) |
| `lib/adapters/prompts.ts` | `PLAN_PROMPT`, `VERIFY_PROMPT`, `fill()` |
| `lib/adapters/parse.ts` | `extractJson`, `findValue`, `parseJsonSafe` |
| `lib/secrets.ts` | Provider cookies: encrypted in `provider_secrets`. The UI only receives names and dates |
| `lib/crypto.ts` | AES-256-GCM encrypt and decrypt |
| `lib/db.ts` | Neon client. Creates tables with `create if not exists` once per instance |
| `lib/logger.ts` | `logEvent` (writes `job_logs` and the console). `redact` removes secrets before anything is stored or shown |
| `lib/session.ts` | Admin session JWT (HS256, 12 hours, signed with `AUTH_SECRET`) |
| `lib/api.ts` | `adminRoute` wrapper (auth check plus JSON errors), `UUID_RE`, `json()` |
| `lib/blob.ts` | Private Blob: `saveDraft`, `openDraft`, `readDraft` |
| `lib/media.ts` | Signed, expiring media URLs (`publicMediaUrl`, `verifyMediaSignature`) |
| `lib/client.ts` | Browser fetch helper (`api()`). Must not import server code |
| `scripts/probe-mcp.ts` | `npm run probe:mcp -- gemini` (or `instagram`): lists a server's tools and argument names. Never prints the key |
| `tests/selftest.ts`, `tests/fake-mcp.ts` | 21 tests. `fake-mcp` is a protocol-level fake MCP server |
| `bridges/` | Optional Python HTTP bridges. `gemini-bridge` (Vercel) and `chatgpt-bridge` (home PC). Not in use now |

## Pipeline (job states)

`queued → researching → analyzing → generating → captioning → publishing → done`, plus `failed`. A failed job
stores `failedStep`, and Retry resumes at that step. `generating` is where the job waits for uploaded pictures. The
tick never picks it up, so it cannot hold up other jobs. `verifying` and `awaiting_review` remain only for jobs made
before the change.

- **researching:** the first call starts research and stores `researchRef` and `researchStartedAt`.
  Later calls poll until done. Over 45 minutes, the job fails.
- **analyzing:** Gemini returns JSON with `analysis` and `picture` (the picture in parts). The app builds the
  prompt. The research report is cleared. A carousel returns one picture per slide, and a shared style.
- **generating:** the job waits. Each picture is uploaded on the job page to its own slot (`POST /api/jobs/[id]/image?slot=N`),
  saved privately to Blob. A carousel picture is cut to the carousel's shape first. Nothing is generated by a model.
- **Continue** (`POST /api/jobs/[id]/continue`, optionally `{at}`): refused until every picture is uploaded. It moves the
  job to `captioning` and sets `manualContinue`. With a time, `scheduled_at` holds the job until then, as for any
  scheduled job. The scheduler is only as punctual as the tick (see the self-driving note above).
- **captioning:** a carousel's text is drawn on each uploaded picture (kept apart as the final picture), then the caption.
  A job with a missing picture goes back to `generating` and waits.
- **awaiting_review:** only for jobs made before the change. A job with `manualContinue` goes straight to `publishing`.
- **publishing:** resumable sub-steps saved in `data.publish`: post photo (`mediaId`), then the
  detail comment (`commentId`), then pin. A retry never posts the photo twice.
- **Mock mode:** nothing external is called and nothing is posted. Steps are marked DRY RUN.

## Providers and transports

| Provider | Used for | Transport now | Env var |
|---|---|---|---|
| Instagram | post, comment, pin | MCP | `INSTAGRAM_MCP_URL` |
| Gemini | research, plan, verify, image | MCP | `GEMINI_MCP_URL` (cookies optional) |
| ChatGPT | not used (pictures are uploaded by hand) | none | `CHATGPT_MCP_URL` or `CHATGPT_BRIDGE_URL` (unused) |

Precedence: MCP URL, then bridge URL, then "missing". A missing transport gives a clear message in Settings.

**Gemini MCP server:** Vercel project `webapi` (GitHub repo `red7773md/webapi`). Python, using the MCP SDK.
Its `/mcp` route requires `?key=`. The key is set by the server's `APP_API_KEY`. The server has an admin
page that shows the MCP URL. Its tool names are not known to the app until probed.

**Instagram MCP server:** `instagram-mcp-api.vercel.app/mcp?auth=KEY`. Tools (exact names and arguments,
from the connector's schema; `*` = required):

- `instagram_post_photo`: `caption*`, `image_path_or_url*` (an http(s) URL works), `aspect` (the app sends
  `"square"`), `disable_comments`, `dry_run` (the app sends `false`). Optional: `hashtags`, `alt_text`,
  `location_name`, `mentions`, `tag_users_in_photo`.
- `instagram_comment_on_post`: `media_id_or_url*`, `text*`.
- `instagram_pin_comment`: `comment_id*`, `media_id_or_url*`, `pin` (the app sends `true`).

**Gemini and ChatGPT tool matching.** Tool names on these servers are not fixed. Each operation is
matched by a score: keywords in the tool name and description, and argument names. Overrides are set
with `GEMINI_TOOL_MAP` or `CHATGPT_TOOL_MAP` (JSON, operation to tool name). A forced name the server
doesn't have is reported as missing, never silently replaced.

| Operation | Needs | Returns |
|---|---|---|
| `startResearch` | "research" in the tool, a prompt argument | an id (JSON key such as `chat_id`/`ref`, or a bare token) |
| `pollResearch` | "research" in the tool, an id argument | `running`, or `done` with the report (JSON or plain text) |
| `plan` | a prompt argument, no image words | JSON: `caption`, `commentBody`, `imagePrompt` |
| `verifyImage` | an image argument and a prompt argument, analysis words | JSON: `pass`, `issues`, `revisedPrompt` |
| `generateImage` | a prompt argument, image words | an image block, a base64 field, or an image URL |

Every MCP request sends the cookie as the `x-provider-cookie` header, if one is saved. It also goes in
an argument whose name contains "cookie", if the tool has one.

**URL keys.** A key containing `# & + %` breaks a URL when pasted raw. `normalizeServerUrl` encodes the
value after `key=` or `auth=`, so URLs can be pasted exactly as given.

## Security model

- One admin account: `ADMIN_USERNAME` plus a bcrypt hash in env. The session cookie is httpOnly and lasts 12 hours.
- Middleware gates every page and API route. Each API handler checks the session again (`adminRoute`).
- The only public route is `/api/media/...`. It needs an HMAC signature from `AUTH_SECRET`, which expires after 30 minutes.
- Cookies are encrypted with AES-256-GCM (`COOKIE_ENCRYPTION_KEY`). The UI never receives values, only names and dates.
- `redact()` removes env secret values, `auth=`/`key=` parameters, cookies, bearer tokens and DB passwords from logs and stored text.
- Blob storage is private. Drafts are reached only through the admin draft route or the signed media route.
- Keys and secrets live only in Vercel env vars or `.env.local` (git-ignored). Never put them in code, docs, tests or chat.

## Environment variables (names only)

Required: `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `AUTH_SECRET`, `COOKIE_ENCRYPTION_KEY`, `DATABASE_URL`,
`PUBLIC_APP_URL`.
Storage: `BLOB_READ_WRITE_TOKEN` (added by Vercel when a Blob store is connected).
Modes: `PROVIDER_MODE` (`mock` default, or `live`).
Servers: `INSTAGRAM_MCP_URL`, `GEMINI_MCP_URL`, `CHATGPT_MCP_URL`, `GEMINI_TOOL_MAP`, `CHATGPT_TOOL_MAP`,
`GEMINI_BRIDGE_URL`, `CHATGPT_BRIDGE_URL`.
`VERCEL_URL` is set automatically by Vercel.

## Commands

```
npm install
npm run dev              # local app (needs .env.local)
npm test                 # 21 self-tests, no network
npx tsc --noEmit         # type check
npm run build            # production build (needs placeholder env values)
npm run probe:mcp -- gemini      # list the Gemini MCP server's tools (needs GEMINI_MCP_URL)
npm run probe:mcp -- instagram   # list the Instagram tools (needs INSTAGRAM_MCP_URL)
```

## Conventions for changes

- Each `advance` call runs exactly one step. Anything slow must be a pending state that later calls poll.
- Keep external calls behind the `Providers` interface (`lib/adapters/types.ts`). Put new operations
  there first, then implement them in every adapter (mock included).
- Publishing sub-steps save progress before the next one runs. Keep that property.
- Log through `logEvent`. Never log raw secrets. Store only redacted text.
- Only the runner writes job state, plus the review and retry routes (which check the current state first).
- The DDL in `lib/db.ts` only uses `create if not exists`. Add columns to existing tables carefully.
- Before finishing a change: `npm test`, `npx tsc --noEmit`, `npm run build`.

## Known gaps and next steps (in priority order)

1. Run `npm run probe:mcp -- gemini`. Confirm the tool names and fix the mapping, or set `GEMINI_TOOL_MAP`.
2. Create the Neon database and the private Blob store, set the env vars, and deploy.
3. Rotate the Gemini and Instagram keys (exposed in chat). Update `GEMINI_MCP_URL` and `INSTAGRAM_MCP_URL` in Vercel.
4. The Gemini HTTP bridge has no image operation. Use the MCP path for images.
5. Research polling depends on the Gemini server's poll reply format (JSON `status` or `report`, or text heuristics).
6. Jobs advance only while the job page is open (Hobby cron runs once a day). Closing the tab pauses a job.
7. Login has only a 0.8-second delay after a failed attempt. No rate limiting.
8. Drafts are never deleted automatically. Clean up Blob storage when needed.

## Glossary

- **MCP:** Model Context Protocol. Servers expose tools over HTTP.
- **Transport:** how a provider is reached (`mcp`, `bridge`, or `none`).
- **Draft:** an uploaded picture, stored privately in Blob under `drafts/{jobId}/{attempt}` (a carousel: `{attempt}-{slide}`).
- **Job:** one topic moving through the pipeline. Its state lives in the `jobs` table.
- **Pictures:** one per post, or one per carousel slide. Each one is made by hand and uploaded to its slot.
