# ChatGPT bridge

A FastAPI service that asks ChatGPT for an image in a normal chat and returns a JPEG of
the result. It drives a real Chromium browser with your saved chatgpt.com cookies.

## Why this runs on your computer, not on Vercel

ChatGPT's web app checks each request with Sentinel proof-of-work and a Cloudflare bot check.
Plain HTTP clients cannot pass those reliably. A real browser passes them the way your own
browser does. A browser needs a full Chromium install and several minutes per image, which
Vercel functions cannot provide. So this bridge runs on a machine you control, and the main
app on Vercel calls it through a tunnel.

Your home connection is the most reliable place to run it. Datacenter IPs, including
Vercel's, are more likely to get a Cloudflare challenge.

## Endpoints

| Method and path | Body | Returns |
|---|---|---|
| `GET /health` | none | `{"ok": true, ...}` when the chat box is reachable with the cookies |
| `POST /image` | `{"prompt": "...", "size": "1024x1024", "format": "jpeg"}` | `{"base64": "...", "mimeType": "image/jpeg"}` |
| `GET /debug/screenshot` | none | PNG of what the bridge's browser sees. Use it when something fails |

The cookie header comes in `x-provider-cookie`. The bridge key comes as `?auth=<BRIDGE_KEY>`
or `Authorization: Bearer <BRIDGE_KEY>`.

## Setup (any OS, Python 3.10+)

```bash
python -m venv .venv
# Windows:  .venv\Scripts\activate
# macOS/Linux:  source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium
```

Set the bridge key, then start the server:

```bash
# macOS / Linux
export BRIDGE_KEY="$(openssl rand -hex 32)"
uvicorn app:app --host 127.0.0.1 --port 8000

# Windows PowerShell
$env:BRIDGE_KEY = "paste-a-long-random-string"
uvicorn app:app --host 127.0.0.1 --port 8000
```

Options (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `BRIDGE_KEY` | required | Shared secret the main app sends |
| `CHATGPT_HEADLESS` | `1` | Set `0` to see the browser window. Useful when Cloudflare blocks headless browsers |
| `CHATGPT_CHANNEL` | bundled Chromium | Set `chrome` to use an installed Google Chrome |
| `CHATGPT_IMAGE_TIMEOUT_MS` | `240000` | How long to wait for an image |
| `CHATGPT_COMPOSER_SELECTOR` | `#prompt-textarea` | Chat input box selector |
| `CHATGPT_IMAGE_SELECTOR` | `[data-message-author-role="assistant"] img` | Selector for the generated image |
| `CHATGPT_STOP_SELECTOR` | `button[data-testid="stop-button"]` | Selector for the stop button |

## Check the selectors first (important)

ChatGPT changes its page layout from time to time. Before you rely on the bridge:

1. Start the bridge with `CHATGPT_HEADLESS=0`.
2. Call `GET /debug/screenshot?auth=<key>` with your cookie header. You should see the chat page,
   signed in. If you see a login page, the cookies are wrong or expired. If you see a
   Cloudflare check, see the notes below.
3. Call `POST /image` with a small prompt. Watch the browser. If the request times out, the
   image selector is probably wrong. Inspect the generated image in the browser's developer
   tools and set `CHATGPT_IMAGE_SELECTOR` to match it.

## Expose it to Vercel with a tunnel

The main app needs an HTTPS URL. Cloudflare Tunnel gives you one for free:

```bash
# install cloudflared from https://github.com/cloudflare/cloudflared/releases
cloudflared tunnel --url http://127.0.0.1:8000
```

It prints a `https://<random>.trycloudflare.com` URL. Set the main app's `CHATGPT_BRIDGE_URL` to
`https://<random>.trycloudflare.com/?auth=<BRIDGE_KEY>`.

The quick tunnel URL changes every time you restart `cloudflared`. For a stable URL, create a
named tunnel with your own domain. That is a short Cloudflare setup, and I can walk you through it.

## Known limits

- Using ChatGPT's web app automatically (this bridge) is against OpenAI's terms and can get the
  account restricted. Use a secondary account.
- Each image opens a new browser, so each request takes roughly 30 to 120 seconds. Requests run one
  at a time, on purpose.
- The bridge creates a normal chat in the account for each image. Delete those chats if you want a
  clean history.
- Image generation depends on your ChatGPT plan's limits. When the limit is reached, the bridge
  returns a 504 with that explanation.
- Cookies expire. A 401 means copy a fresh Cookie header from chatgpt.com into the app's Settings.
