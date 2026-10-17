"""
ChatGPT bridge for Insta Agent (image generation).

Drives a real Chromium with your saved chatgpt.com cookies, asks ChatGPT to
create one image in a normal chat, and returns a JPEG of the result.

Why a browser: ChatGPT's web app requires Sentinel proof-of-work and a
Cloudflare check. Plain HTTP clients fail those checks, while a real browser
runs them the same way your own browser does. That is also why this service
cannot run on a serverless function. Run it on a machine you control (see README).
"""

import asyncio
import base64
import hmac
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from playwright.async_api import Page, TimeoutError as PWTimeout, async_playwright
from pydantic import BaseModel

BRIDGE_KEY = os.environ.get("BRIDGE_KEY", "")
HEADLESS = os.environ.get("CHATGPT_HEADLESS", "1") != "0"
CHANNEL = os.environ.get("CHATGPT_CHANNEL") or None  # e.g. "chrome" to use an installed Chrome
CHAT_URL = "https://chatgpt.com/"
# These selectors are the parts of the ChatGPT page most likely to change.
# Verify them on the first run with GET /debug/screenshot and adjust via env.
COMPOSER = os.environ.get("CHATGPT_COMPOSER_SELECTOR", "#prompt-textarea")
IMAGE_SELECTOR = os.environ.get("CHATGPT_IMAGE_SELECTOR", '[data-message-author-role="assistant"] img')
STOP_BUTTON = os.environ.get("CHATGPT_STOP_SELECTOR", 'button[data-testid="stop-button"]')
IMAGE_TIMEOUT_MS = int(os.environ.get("CHATGPT_IMAGE_TIMEOUT_MS", "240000"))
MIN_IMAGE_BYTES = 4000  # anything smaller is an icon, not a generated image

_lock = asyncio.Lock()  # one browser at a time keeps the home machine responsive
app = FastAPI(title="Insta Agent - ChatGPT bridge")


class BridgeError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


@app.exception_handler(BridgeError)
async def bridge_error_handler(_: Request, exc: BridgeError) -> JSONResponse:
    return JSONResponse({"error": str(exc)}, status_code=exc.status)


@app.exception_handler(HTTPException)
async def http_error_handler(_: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code)


@app.middleware("http")
async def catch_unexpected(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception as exc:
        return JSONResponse({"error": f"ChatGPT bridge error: {type(exc).__name__}: {exc}"}, status_code=502)


def require_key(request: Request) -> None:
    if not BRIDGE_KEY:
        raise HTTPException(500, "BRIDGE_KEY is not set on the bridge")
    supplied = request.query_params.get("auth", "")
    bearer = request.headers.get("authorization", "").removeprefix("Bearer ")
    if not (hmac.compare_digest(supplied, BRIDGE_KEY) or hmac.compare_digest(bearer, BRIDGE_KEY)):
        raise HTTPException(401, "bad or missing bridge key")


def cookie_list(header: Optional[str]) -> list[dict]:
    if not header:
        raise BridgeError(401, "missing x-provider-cookie header")
    items = []
    for part in header.split(";"):
        if "=" in part:
            name, value = part.strip().split("=", 1)
            if name:
                items.append({"name": name, "value": value, "url": CHAT_URL})
    if not items:
        raise BridgeError(401, "the saved ChatGPT cookies are empty. Paste the full Cookie header from chatgpt.com")
    return items


@asynccontextmanager
async def chat_page(cookie_header: Optional[str]) -> AsyncIterator[Page]:
    cookies = cookie_list(cookie_header)
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=HEADLESS, channel=CHANNEL)
        try:
            context = await browser.new_context(viewport={"width": 1280, "height": 900}, locale="en-US")
            await context.add_cookies(cookies)
            page = await context.new_page()
            yield page
        finally:
            await browser.close()


async def ensure_ready(page: Page) -> None:
    await page.goto(CHAT_URL, wait_until="domcontentloaded", timeout=60_000)
    try:
        await page.wait_for_selector(COMPOSER, timeout=45_000)
    except PWTimeout:
        title = (await page.title()).lower()
        challenged = "just a moment" in title or await page.locator("iframe[src*='challenges.cloudflare.com']").count() > 0
        if challenged:
            raise BridgeError(
                503,
                "Cloudflare is showing a bot check. Run the bridge on a normal home connection, "
                "or set CHATGPT_HEADLESS=0 so the browser window is visible.",
            )
        raise BridgeError(
            401,
            "ChatGPT did not show the chat box. The cookies have probably expired. "
            "Copy a fresh Cookie header from chatgpt.com and save it in Settings.",
        )


async def generate_image(cookie_header: Optional[str], prompt: str) -> bytes:
    request_text = (
        "Create one square image (1:1) for this brief. Do not add any text, letters or numbers "
        f"to the image. Brief: {prompt}"
    )
    async with chat_page(cookie_header) as page:
        await ensure_ready(page)
        before = await page.locator(IMAGE_SELECTOR).count()

        await page.click(COMPOSER)
        await page.keyboard.insert_text(request_text)
        await page.keyboard.press("Enter")

        try:
            await page.wait_for_function(
                "([sel, n]) => document.querySelectorAll(sel).length > n",
                arg=[IMAGE_SELECTOR, before],
                timeout=IMAGE_TIMEOUT_MS,
            )
        except PWTimeout:
            raise BridgeError(
                504,
                "ChatGPT did not return an image in time. It may have refused the request or reached "
                "its image limit. Check the chat in a normal browser.",
            )

        img = page.locator(IMAGE_SELECTOR).nth(before)
        await img.wait_for(state="visible", timeout=60_000)
        # Wait until the image has actually loaded, not just appeared.
        await img.evaluate(
            "el => new Promise(resolve => {"
            "  const ok = () => el.complete && el.naturalWidth > 0;"
            "  if (ok()) return resolve(true);"
            "  el.addEventListener('load', () => resolve(true));"
            "  setTimeout(() => resolve(false), 60000);"
            "})"
        )
        # Let the reply finish streaming before taking the picture.
        try:
            await page.wait_for_selector(STOP_BUTTON, state="detached", timeout=120_000)
        except PWTimeout:
            pass

        data = await img.screenshot(type="jpeg", quality=92)
        if len(data) < MIN_IMAGE_BYTES:
            raise BridgeError(502, f"captured only {len(data)} bytes, so the selector probably matched an icon, not the image")
        return data


# ---------- endpoints ----------

class ImageBody(BaseModel):
    prompt: str
    size: str = "1024x1024"  # the brief asks for a 1:1 square; size is kept for contract parity
    format: str = "jpeg"


@app.get("/health")
async def health(request: Request):
    require_key(request)
    async with _lock:
        async with chat_page(request.headers.get("x-provider-cookie")) as page:
            await ensure_ready(page)
    return {"ok": True, "message": "ChatGPT chat box reachable with the saved cookies"}


@app.post("/image")
async def image(body: ImageBody, request: Request):
    require_key(request)
    if not body.prompt.strip():
        raise HTTPException(400, "prompt is empty")
    async with _lock:
        data = await generate_image(request.headers.get("x-provider-cookie"), body.prompt)
    return {"base64": base64.b64encode(data).decode(), "mimeType": "image/jpeg"}


@app.get("/debug/screenshot")
async def debug_screenshot(request: Request):
    """PNG of what the bridge's browser sees. Use it to debug login, Cloudflare and selector problems."""
    require_key(request)
    async with _lock:
        async with chat_page(request.headers.get("x-provider-cookie")) as page:
            await page.goto(CHAT_URL, wait_until="domcontentloaded", timeout=60_000)
            await asyncio.sleep(5)
            png = await page.screenshot(type="png", full_page=False)
    return Response(content=png, media_type="image/png")
