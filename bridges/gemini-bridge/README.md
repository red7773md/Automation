# Gemini bridge

A small FastAPI service that gives the Insta Agent app the Gemini calls it needs. It wraps
[HanaokaYuzu/Gemini-API](https://github.com/HanaokaYuzu/Gemini-API) (`gemini-webapi` on PyPI),
an open-source, cookie-based client for the Gemini web app. It supports deep research with
polling, file input for verification, and plain text generation.

It runs on Vercel as its own project, separate from the main app. That keeps the Gemini
dependencies out of the Next.js build, and you can update it on its own.

## Endpoints (the contract the main app uses)

| Method and path | Body | Returns |
|---|---|---|
| `GET /health` | none | `{"ok": true, "message": "..."}` |
| `POST /research/start` | `{"topic": "..."}` | `{"ref": "<chat id>", "title": "...", "eta": "..."}` |
| `POST /research/poll` | `{"ref": "<chat id>"}` | `{"status": "running"}` or `{"status": "done", "report": "<markdown>"}` |
| `POST /plan` | `{"topic": "...", "report": "..."}` | `{"caption", "commentBody", "imagePrompt"}` |
| `POST /verify` | `{"topic", "plan", "attempt", "image": {"mimeType", "base64"}}` | `{"pass", "issues": [...], "revisedPrompt"}` |

Every call needs the saved Gemini cookie header in `x-provider-cookie`. The service only
reads `__Secure-1PSID` and `__Secure-1PSIDTS` from it.

Every call also needs the bridge key, as `?auth=<BRIDGE_KEY>` on the URL or as
`Authorization: Bearer <BRIDGE_KEY>`.

Errors always come back as `{"error": "..."}`. A 401 means the cookies or the key were rejected.

## Deploy on Vercel

1. Create a new GitHub repo containing only this folder (or import the whole repo and set
   **Root Directory** to `bridges/gemini-bridge`).
2. In Vercel, **Add New → Project**, import the repo, and keep the framework preset as
   "Other" or "FastAPI". Vercel finds `app.py` and `requirements.txt`.
3. Environment variable: `BRIDGE_KEY` = a random string, for example `openssl rand -hex 32`.
   Mark it Sensitive.
4. In **Settings → Functions**, raise **Max Duration** to the maximum your plan allows (300 s
   on Hobby). Plan and verify calls can take a minute or more.
5. Deploy. Your bridge URL is `https://<project>.vercel.app/?auth=<BRIDGE_KEY>`.
6. In the main app's Vercel project, set `GEMINI_BRIDGE_URL` to that URL.

## Run locally

```bash
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt uvicorn
BRIDGE_KEY=test-key uvicorn app:app --reload --port 8001
```

## Quick check

```bash
curl "http://localhost:8001/health?auth=test-key" -H "x-provider-cookie: __Secure-1PSID=...; __Secure-1PSIDTS=..."
```

A reply of `{"ok": true, ...}` means the cookies work. Use the **Test connection** button
in the app's Settings page to check the same thing through the real deployment.

## Known limits

- Gemini is a web app reverse-engineered by a third party. Google can change it at any time.
  When that happens, update `gemini-webapi` in `requirements.txt` and redeploy.
- Cookies expire. When they do, `/health` returns 401 and the job log says so. Copy a fresh
  Cookie header from gemini.google.com into the app's Settings page. The bridge stores nothing.
- Deep research reports take roughly 5 to 10 minutes. The main app polls for up to 45 minutes.
- Using web cookies from a Google account is against Google's terms. Use a secondary account.
