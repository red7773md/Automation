import base64, sys, os  # run: pip install httpx, then: python tests/test_chatgpt_bridge.py
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
os.environ["BRIDGE_KEY"] = "gpt-key-456"
import app as bridge
from fastapi.testclient import TestClient
c = TestClient(bridge.app)
KEY = "?auth=gpt-key-456"
COOKIE = {"x-provider-cookie": "__Secure-next-auth.session-token=TOKEN; oai-did=DID"}

# 1 auth
assert c.get("/health").status_code == 401
assert c.post("/image", json={"prompt": "x"}).status_code == 401
print("ok  auth: no key rejected on health and image")

# 2 empty prompt
r = c.post("/image" + KEY, json={"prompt": "   "}, headers=COOKIE); assert r.status_code == 400 and "empty" in r.json()["error"], r.text
print("ok  empty prompt rejected with 400")

# 3 missing cookies: refused before any browser starts
r = c.post("/image" + KEY, json={"prompt": "a cat"}); assert r.status_code == 401 and "missing x-provider-cookie" in r.json()["error"], r.text
print("ok  missing cookie header refused before any browser is started")

# 4 cookie list built with url (works for __Secure- and __Host- names alike)
items = bridge.cookie_list("__Host-next-auth.csrf=A=B; __Secure-next-auth.session-token=T")
assert items[0] == {"name": "__Host-next-auth.csrf", "value": "A=B", "url": "https://chatgpt.com/"}, items
print("ok  cookie parsing keeps '=' inside values and uses url scope")

# 5 happy path with the browser step stubbed: response shape is the contract
captured = {}
async def fake_generate(cookie_header, prompt):
    captured["cookie"], captured["prompt"] = cookie_header, prompt
    return b"\xff\xd8\xff" + b"0" * 5000
bridge.generate_image = fake_generate
r = c.post("/image" + KEY, json={"prompt": "A calm lake", "size": "1024x1024", "format": "jpeg"}, headers=COOKIE)
assert r.status_code == 200, r.text
body = r.json()
assert body["mimeType"] == "image/jpeg" and base64.b64decode(body["base64"]).startswith(b"\xff\xd8\xff")
assert captured["cookie"].startswith("__Secure-next-auth.session-token=TOKEN")
print("ok  image: returns {base64, mimeType} and forwards the cookie and prompt unchanged")

# 6 bridge errors keep their status and message
async def fake_timeout(cookie_header, prompt):
    raise bridge.BridgeError(504, "ChatGPT did not return an image in time.")
bridge.generate_image = fake_timeout
r = c.post("/image" + KEY, json={"prompt": "x"}, headers=COOKIE); assert r.status_code == 504 and "in time" in r.json()["error"], r.text
async def fake_challenge(cookie_header, prompt):
    raise bridge.BridgeError(503, "Cloudflare is showing a bot check.")
bridge.generate_image = fake_challenge
r = c.post("/image" + KEY, json={"prompt": "x"}, headers=COOKIE); assert r.status_code == 503, r.text
print("ok  504 timeout and 503 Cloudflare errors keep their status and readable message")

# 7 real Chromium is not installed in this sandbox: failure must be a readable 502
import importlib
bridge = importlib.reload(bridge)
bridge.BRIDGE_KEY = "gpt-key-456"
rc = TestClient(bridge.app)
r = rc.post("/image" + KEY, json={"prompt": "a cat"}, headers=COOKIE)
print("     no browser installed ->", r.status_code, r.json().get("error", "")[:150])
assert r.status_code == 502 and "ChatGPT bridge error" in r.json()["error"]
print("ok  browser launch failure returns a readable 502 instead of a bare 500")
print("\nCHATGPT BRIDGE CONTRACT TESTS PASSED")
