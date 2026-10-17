"""
Gemini bridge for Insta Agent.

Wraps HanaokaYuzu/Gemini-API (gemini-webapi on PyPI) behind the bridge contract
the Next.js app expects (see README.md, "Bridge contract").

Every request carries the saved Gemini cookie header in `x-provider-cookie`, so
this service stores no secrets. Each request builds its own client. Nothing is
kept between requests, which is what serverless hosting needs. Deep research
runs server-side at Gemini: /research/start only starts it and returns the chat
id, and /research/poll checks that chat later.
"""

import hmac
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from gemini_webapi import (
    AuthError,
    GeminiClient,
    GeminiError,
    ModelOutput,
    UsageLimitExceededError,
)
from gemini_webapi import TimeoutError as GeminiTimeout
from pydantic import BaseModel

BRIDGE_KEY = os.environ.get("BRIDGE_KEY", "")

app = FastAPI(title="Insta Agent - Gemini bridge")


# ---------- auth and cookies ----------

def require_key(request: Request) -> None:
    if not BRIDGE_KEY:
        raise HTTPException(500, "BRIDGE_KEY is not set on the bridge")
    supplied = request.query_params.get("auth", "")
    bearer = request.headers.get("authorization", "").removeprefix("Bearer ")
    if not (hmac.compare_digest(supplied, BRIDGE_KEY) or hmac.compare_digest(bearer, BRIDGE_KEY)):
        raise HTTPException(401, "bad or missing bridge key")


def read_cookies(header: Optional[str]) -> tuple[str, Optional[str]]:
    if not header:
        raise HTTPException(401, "missing x-provider-cookie header")
    jar: dict[str, str] = {}
    for part in header.split(";"):
        if "=" in part:
            name, value = part.strip().split("=", 1)
            jar[name] = value
    psid = jar.get("__Secure-1PSID")
    if not psid:
        raise HTTPException(401, "the saved cookies have no __Secure-1PSID. Copy the full Cookie header from gemini.google.com")
    return psid, jar.get("__Secure-1PSIDTS")


async def open_client(request: Request) -> GeminiClient:
    psid, psidts = read_cookies(request.headers.get("x-provider-cookie"))
    client = GeminiClient(psid, psidts)
    # auto_refresh=False: serverless instances are short-lived, so background
    # cookie rotation would never persist. The app re-sends the saved cookie.
    await client.init(timeout=60, auto_close=False, auto_refresh=False)
    return client


async def close_client(client: GeminiClient) -> None:
    try:
        await client.close()
    except Exception:
        pass


# ---------- error mapping ----------

@app.exception_handler(GeminiError)
async def gemini_error_handler(_: Request, exc: GeminiError) -> JSONResponse:
    status = 429 if isinstance(exc, UsageLimitExceededError) else 504 if isinstance(exc, GeminiTimeout) else 502
    return JSONResponse({"error": f"{type(exc).__name__}: {exc}"}, status_code=status)


@app.exception_handler(AuthError)
async def auth_error_handler(_: Request, exc: AuthError) -> JSONResponse:
    # The app turns 401 into "cookies expired" guidance.
    return JSONResponse({"error": f"Gemini rejected the cookies: {exc}"}, status_code=401)


@app.exception_handler(HTTPException)
async def http_error_handler(_: Request, exc: HTTPException) -> JSONResponse:
    # One error shape for every failure: {"error": "..."}, which the app reads.
    return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code)


@app.middleware("http")
async def catch_unexpected(request: Request, call_next):
    # Network failures and parser bugs become readable 502s instead of bare 500s.
    try:
        return await call_next(request)
    except Exception as exc:
        return JSONResponse({"error": f"Gemini bridge error: {type(exc).__name__}: {exc}"}, status_code=502)


# ---------- helpers ----------

def extract_json(text: str) -> dict[str, Any]:
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE)
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end <= start:
        raise HTTPException(502, f"Gemini did not return JSON. Start of reply: {text[:300]!r}")
    try:
        return json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError as err:
        raise HTTPException(502, f"Gemini returned malformed JSON ({err}). Start of reply: {text[:300]!r}")


PLAN_INSTRUCTIONS = """You are preparing an Instagram post from a research report.
Return ONLY a JSON object with exactly these three string keys:
- "caption": a short hook (at most two sentences) followed by 5 to 10 relevant hashtags.
- "commentBody": the detailed description for the first comment, factual and readable, at most 1800 characters, using short paragraphs or bullet lines.
- "imagePrompt": a detailed prompt for an image generator. Square composition. No text, letters or numbers in the image. No real people's faces, logos or brand names.
Do not wrap the JSON in markdown fences and do not write anything outside the JSON.

Topic: {topic}

Research report:
{report}
"""

VERIFY_INSTRUCTIONS = """You are checking an AI-generated image before it is posted to Instagram.
Post topic: {topic}
Image prompt that was used: {prompt}

Check the attached image for:
1. It matches the topic and the prompt.
2. No garbled, misspelled or unreadable text.
3. No distorted faces, hands or extra limbs.
4. No watermarks, logos or brand names.
5. It looks clean and suitable for Instagram.

Return ONLY a JSON object:
{"pass": true or false, "issues": ["one short sentence per problem"], "revisedPrompt": "a complete improved image prompt that fixes the problems (only when pass is false, otherwise an empty string)"}
Do not write anything outside the JSON."""


def fill(template: str, **values: str) -> str:
    out = template
    for key, value in values.items():
        out = out.replace("{" + key + "}", value)
    return out


# ---------- models ----------

class TopicBody(BaseModel):
    topic: str


class RefBody(BaseModel):
    ref: str


class PlanBody(BaseModel):
    topic: str
    report: str


class ImagePayload(BaseModel):
    mimeType: str
    base64: str


class PlanPayload(BaseModel):
    caption: str = ""
    commentBody: str = ""
    imagePrompt: str = ""


class VerifyBody(BaseModel):
    topic: str
    plan: PlanPayload
    attempt: int = 1
    image: ImagePayload


def has_report(output: Optional[ModelOutput]) -> bool:
    doc = output.deep_research_document if output else None
    return bool(doc and doc.ready)


# ---------- endpoints ----------

@app.get("/health")
async def health(request: Request):
    require_key(request)
    client = await open_client(request)
    await close_client(client)
    return {"ok": True, "message": "Signed in to Gemini with the saved cookies"}


@app.post("/research/start")
async def research_start(body: TopicBody, request: Request):
    require_key(request)
    client = await open_client(request)
    try:
        chat = client.start_chat()
        plan = await client.create_deep_research_plan(body.topic, chat=chat)
        await client.start_deep_research(plan, chat=chat)
        if not plan.cid:
            raise HTTPException(502, "Gemini started research but returned no chat id")
        return {"ref": plan.cid, "title": plan.title, "eta": plan.eta_text}
    finally:
        await close_client(client)


@app.post("/research/poll")
async def research_poll(body: RefBody, request: Request):
    require_key(request)
    client = await open_client(request)
    try:
        output = await client.fetch_latest_chat_response(body.ref, limit=10, match=has_report)
        if output and has_report(output):
            doc = output.deep_research_document
            return {"status": "done", "report": doc.markdown}
        return {"status": "running", "progress": "Gemini is still researching"}
    finally:
        await close_client(client)


@app.post("/plan")
async def plan(body: PlanBody, request: Request):
    require_key(request)
    client = await open_client(request)
    try:
        prompt = fill(PLAN_INSTRUCTIONS, topic=body.topic, report=body.report)
        output = await client.generate_content(prompt)
        data = extract_json(output.text)
        return {
            "caption": str(data.get("caption", "")),
            "commentBody": str(data.get("commentBody", "")),
            "imagePrompt": str(data.get("imagePrompt", "")),
        }
    finally:
        await close_client(client)


@app.post("/verify")
async def verify(body: VerifyBody, request: Request):
    require_key(request)
    import base64

    suffix = ".png" if "png" in body.image.mimeType else ".jpg"
    fd, path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(base64.b64decode(body.image.base64))
        client = await open_client(request)
        try:
            prompt = fill(VERIFY_INSTRUCTIONS, topic=body.topic, prompt=body.plan.imagePrompt)
            output = await client.generate_content(prompt, files=[Path(path)])
            data = extract_json(output.text)
        finally:
            await close_client(client)
    finally:
        Path(path).unlink(missing_ok=True)

    passed = data.get("pass") is True or str(data.get("pass")).lower() == "true"
    issues = data.get("issues") or []
    revised = str(data.get("revisedPrompt") or "").strip()
    return {
        "pass": passed,
        "issues": [str(i) for i in issues] if isinstance(issues, list) else [str(issues)],
        "revisedPrompt": revised or None,
    }
