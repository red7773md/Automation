import base64, json, sys, os  # run: pip install httpx, then: python tests/test_gemini_bridge.py
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
os.environ["BRIDGE_KEY"] = "test-key-123"
import app as bridge
from fastapi.testclient import TestClient
from gemini_webapi import TimeoutError as GeminiTimeout

KEY = "?auth=test-key-123"
COOKIE = {"x-provider-cookie": "__Secure-1PSID=PSID_VALUE; __Secure-1PSIDTS=TS_VALUE; NID=zzz"}
seen = {"ctor": None, "files": None, "polls": 0, "prompts": []}

class Out:
    def __init__(self, text=None, doc=None):
        self.text = text
        self.deep_research_document = doc

class Doc:
    def __init__(self, content): self.content = content
    @property
    def ready(self): return bool(self.content.strip())
    @property
    def markdown(self): return self.content + "\n\n## Sources\n1. [x](https://x)\n"

class Plan:
    cid = "c_abc123"; title = "Test title"; eta_text = "5 min"

class FakeChat:
    cid = None

class FakeClient:
    behaviour = {}
    def __init__(self, psid, psidts=None, proxy=None):
        seen["ctor"] = (psid, psidts)
    async def init(self, **kw): return None
    async def close(self, delay=0): return None
    def start_chat(self, **kw): return FakeChat()
    async def create_deep_research_plan(self, prompt, chat=None, model=None): return Plan()
    async def start_deep_research(self, plan, chat=None, confirm_prompt=None): return Out("started")
    async def fetch_latest_chat_response(self, cid, limit=5, match=None):
        seen["polls"] += 1
        if seen["polls"] < 2:
            return Out("notice", Doc(""))
        return Out("I've completed your research", Doc("# Report\nbody text"))
    async def generate_content(self, prompt, files=None, **kw):
        seen["prompts"].append(prompt)
        if files:
            seen["files"] = [str(f) for f in files]
            return Out(FakeClient.behaviour.get("verify", '{"pass": false, "issues": ["text garbled"], "revisedPrompt": "clean image"}'))
        return Out(FakeClient.behaviour.get("plan", '```json\n{"caption":"Hook #a #b","commentBody":"Details","imagePrompt":"img prompt"}\n```'))

bridge.GeminiClient = FakeClient
c = TestClient(bridge.app)

# 1 auth
r = c.get("/health"); assert r.status_code == 401, r.text
r = c.get("/health" + KEY, headers={"x-provider-cookie": "__Secure-1PSID=A"}); assert r.status_code == 200, r.text
assert seen["ctor"] == ("A", None), seen["ctor"]
r = c.get("/health?auth=wrong", headers=COOKIE); assert r.status_code == 401
print("ok  auth: missing/wrong key rejected, bearer-less query key accepted")

# 2 cookies
r = c.get("/health" + KEY, headers={"x-provider-cookie": "NID=only"}); assert r.status_code == 401 and "__Secure-1PSID" in r.json()["error"], r.text
r = c.get("/health" + KEY); assert r.status_code == 401
r = c.get("/health" + KEY, headers=COOKIE); assert r.status_code == 200
assert seen["ctor"] == ("PSID_VALUE", "TS_VALUE"), seen["ctor"]
print("ok  cookie header parsed: PSID and PSIDTS extracted, missing PSID gives clear 401")

# 3 deep research start / poll
r = c.post("/research/start" + KEY, json={"topic": "coffee"}, headers=COOKIE); assert r.status_code == 200, r.text
assert r.json()["ref"] == "c_abc123", r.json()
r = c.post("/research/poll" + KEY, json={"ref": "c_abc123"}, headers=COOKIE); assert r.json()["status"] == "running", r.json()
r = c.post("/research/poll" + KEY, json={"ref": "c_abc123"}, headers=COOKIE)
assert r.json()["status"] == "done" and r.json()["report"].startswith("# Report"), r.json()
print("ok  research: start returns chat ref, poll reports running then done with markdown report")

# 4 plan (fenced JSON from model)
r = c.post("/plan" + KEY, json={"topic": "coffee", "report": "facts"}, headers=COOKIE); assert r.status_code == 200, r.text
assert r.json() == {"caption": "Hook #a #b", "commentBody": "Details", "imagePrompt": "img prompt"}, r.json()
FakeClient.behaviour["plan"] = "Sure! here you go: {not valid"
r = c.post("/plan" + KEY, json={"topic": "coffee", "report": "facts"}, headers=COOKIE); assert r.status_code == 502 and "malformed" in r.json()["error"] or "did not return JSON" in r.json()["error"], r.text
FakeClient.behaviour.pop("plan")
print("ok  plan: fenced JSON parsed, malformed reply gives 502 with a reason")

# 5 verify: image bytes are written to a temp file, verdict normalised
img = b"\x89PNG-fake-bytes"
body = {"topic": "coffee", "plan": {"caption": "c", "commentBody": "d", "imagePrompt": "p"}, "attempt": 1,
        "image": {"mimeType": "image/png", "base64": base64.b64encode(img).decode()}}
r = c.post("/verify" + KEY, json=body, headers=COOKIE); assert r.status_code == 200, r.text
v = r.json(); assert v == {"pass": False, "issues": ["text garbled"], "revisedPrompt": "clean image"}, v
assert seen["files"] and seen["files"][0].endswith(".png")
assert not os.path.exists(seen["files"][0]), "temp image must be deleted"
FakeClient.behaviour["verify"] = '{"pass": "true", "issues": []}'
r = c.post("/verify" + KEY, json=body, headers=COOKIE); assert r.json() == {"pass": True, "issues": [], "revisedPrompt": None}, r.json()
print("ok  verify: image passed as a file, temp file removed, string pass flag coerced, empty revision -> null")

# 6 error mapping: timeouts from the library become 504; unexpected exceptions become readable 502
class Boom(FakeClient):
    async def generate_content(self, *a, **k): raise GeminiTimeout("took too long")
bridge.GeminiClient = Boom
r = c.post("/plan" + KEY, json={"topic": "t", "report": "r"}, headers=COOKIE); assert r.status_code == 504 and "took too long" in r.json()["error"], r.text
bridge.GeminiClient = bridge.__dict__.get("GeminiClient")
print("ok  library timeout maps to 504 with message")

# 7 real library, no network: must fail with a readable 502, not a bare 500
import importlib
real = importlib.reload(bridge)
real.BRIDGE_KEY = "test-key-123"
rc = TestClient(real.app)
r = rc.get("/health" + KEY, headers={"x-provider-cookie": "__Secure-1PSID=bogus"})
print("     real library, no network ->", r.status_code, r.json().get("error", "")[:140])
assert r.status_code in (401, 502, 504) and "error" in r.json()
print("ok  unreachable Google returns a readable JSON error")
print("\nGEMINI BRIDGE CONTRACT TESTS PASSED")
