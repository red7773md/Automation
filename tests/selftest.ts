// Run with: npm test
// Covers the pure logic (crypto, cookies, plans, redaction, signed media, PNG) and
// the MCP adapters against fake servers (Instagram, Gemini, ChatGPT, health checks).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { crc32, inflateSync } from "node:zlib";
import { startFakeMcp, type FakeTool } from "./fake-mcp";

process.env.COOKIE_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.AUTH_SECRET = randomBytes(48).toString("base64");
process.env.PUBLIC_APP_URL = "https://app.example.com";
process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db";

let passed = 0;
const ok = (label: string) => {
  passed++;
  console.log(`ok  ${label}`);
};

async function main() {
  const { encrypt, decrypt } = await import("@/lib/crypto");
  const { normalizeCookie } = await import("@/lib/secrets");
  const { normalizePlan } = await import("@/lib/jobs/steps");
  const { redact } = await import("@/lib/logger");
  const { publicMediaUrl, verifyMediaSignature } = await import("@/lib/media");
  const { makePng } = await import("@/lib/adapters/mock");
  const { instagram } = await import("@/lib/adapters/instagram-mcp");
  const { createGemini, createChatGpt, resolve, parseToolMap, interpretPoll } = await import("@/lib/adapters/ai-mcp");

  // ---------- pure logic ----------
  const c = encrypt("__Secure-1PSID=abc; x=1");
  assert.equal(decrypt(c), "__Secure-1PSID=abc; x=1");
  const tampered = Buffer.from(c, "base64");
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decrypt(tampered.toString("base64")));
  ok("encryption round trip, tamper detected");

  assert.equal(normalizeCookie("cookie: a=1;\n b=2 ;"), "a=1; b=2");
  assert.throws(() => normalizeCookie("just some text"));
  ok("cookie header normalisation");

  const plan = normalizePlan({ caption: "Hook #tag", commentBody: "Details", imagePrompt: "img" });
  assert.ok(plan.caption.includes("pinned comment"));
  assert.throws(() => normalizePlan({ caption: "x", commentBody: "", imagePrompt: "y" }), /commentBody/);
  assert.ok(normalizePlan({ caption: "a".repeat(5000), commentBody: "b", imagePrompt: "c" }).caption.length <= 2200);
  ok("plan normalisation: pointer added, limits enforced, incomplete plans rejected");

  const r = redact("GET https://host/mcp?auth=SECRETKEY123&x=1 failed; cookie __Secure-1PSID=zzz123; Bearer abc.def");
  assert.ok(!r.includes("SECRETKEY123") && !r.includes("zzz123") && !r.includes("abc.def"), r);
  assert.ok(redact(`leak ${process.env.AUTH_SECRET}`).includes("[AUTH_SECRET]"));
  ok("redaction: query keys, cookies, bearer tokens, env secrets");

  const jobId = "11111111-2222-3333-4444-555555555555";
  const url = new URL(publicMediaUrl(jobId, 2));
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig")!;
  assert.equal(url.origin, "https://app.example.com");
  assert.equal(verifyMediaSignature(jobId, 2, exp, sig), true);
  assert.equal(verifyMediaSignature(jobId, 3, exp, sig), false);
  assert.equal(verifyMediaSignature(jobId, 2, exp + 1, sig), false);
  assert.equal(verifyMediaSignature(jobId, 2, Math.floor(Date.now() / 1000) - 10, sig), false);
  ok("signed media URLs: valid accepted; other attempt, changed expiry, expired rejected");

  const png = makePng(64);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let pos = 8;
  const types: string[] = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const body = png.subarray(pos + 4, pos + 8 + len);
    assert.equal(png.readUInt32BE(pos + 8 + len), crc32(body), "bad chunk CRC");
    types.push(png.subarray(pos + 4, pos + 8).toString("ascii"));
    pos += 12 + len;
  }
  assert.deepEqual(types, ["IHDR", "IDAT", "IEND"]);
  const idat = png.indexOf(Buffer.from("IDAT"));
  assert.equal(inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4))).length, 64 * (64 * 3 + 1));
  ok("mock PNG: signature, CRCs and pixel data valid");

  const { normalizeServerUrl } = await import("@/lib/adapters/mcp");
  const rawKey = "TEST1#a!b@c$d^e&f*g+h%i_j"; // synthetic key with the same awkward characters
  const fixed = new URL(normalizeServerUrl(`https://h.example/mcp?key=${rawKey}`));
  assert.equal(fixed.searchParams.get("key"), rawKey, "the server must receive the whole key");
  assert.equal(normalizeServerUrl("https://h.example/mcp?key=a%23b"), "https://h.example/mcp?key=a%23b");
  assert.equal(normalizeServerUrl("https://h.example/mcp"), "https://h.example/mcp");
  ok("MCP URL: raw keys with # & + % are encoded so the whole key arrives; encoded URLs are left alone");

  // ---------- Instagram MCP: exact tool and argument names ----------
  const igCalls: Array<{ name: string; args: any }> = [];
  const igFake = await startFakeMcp({
    key: "good-key",
    tools: [
      {
        name: "instagram_post_photo",
        inputSchema: { properties: { caption: { type: "string" }, image_path_or_url: { type: "string" }, aspect: { type: "string" }, dry_run: { type: "boolean" }, disable_comments: { type: "boolean" } }, required: ["caption", "image_path_or_url"] },
        handle: () => ({ text: JSON.stringify({ media_id: "17900000001" }) }),
      },
      {
        name: "instagram_comment_on_post",
        inputSchema: { properties: { media_id_or_url: { type: "string" }, text: { type: "string" } }, required: ["media_id_or_url", "text"] },
        handle: () => ({ text: JSON.stringify({ comment_id: "17800000002" }) }),
      },
      {
        name: "instagram_pin_comment",
        inputSchema: { properties: { comment_id: { type: "string" }, media_id_or_url: { type: "string" }, pin: { type: "boolean" } }, required: ["comment_id", "media_id_or_url"] },
        handle: () => ({ text: "pinned" }),
      },
    ],
  });
  process.env.INSTAGRAM_MCP_URL = `${igFake.url}?auth=good-key`;
  const tools = await instagram.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["instagram_post_photo", "instagram_comment_on_post", "instagram_pin_comment"]);
  const post = await instagram.postPhoto({ imageUrl: "https://app.example.com/api/media/x/1?sig=y", caption: "hello" });
  assert.equal(post.mediaId, "17900000001");
  const com = await instagram.comment({ mediaId: post.mediaId, text: "details" });
  assert.equal(com.commentId, "17800000002");
  await instagram.pin({ commentId: com.commentId, mediaId: post.mediaId });
  const [postCall, commentCall, pinCall] = igFake.calls;
  assert.deepEqual(postCall.args, { caption: "hello", image_path_or_url: "https://app.example.com/api/media/x/1?sig=y", aspect: "square", disable_comments: false, dry_run: false });
  assert.deepEqual(commentCall.args, { media_id_or_url: "17900000001", text: "details" });
  assert.deepEqual(pinCall.args, { comment_id: "17800000002", media_id_or_url: "17900000001", pin: true });
  ok("Instagram: post, comment and pin send the schema's exact argument names");

  process.env.INSTAGRAM_MCP_URL = `${igFake.url}?auth=wrong-key`;
  await assert.rejects(() => instagram.listTools(), /HTTP 401/);
  process.env.INSTAGRAM_MCP_URL = `${igFake.url}?auth=good-key`;
  await igFake.close();
  ok("Instagram: wrong key in the URL is rejected with a clear error");

  // ---------- Gemini MCP: tool discovery among decoys ----------
  let statusPolls = 0;
  const geminiTools: FakeTool[] = [
    { name: "gemini_list_chats", description: "List recent chats", inputSchema: { properties: {} }, handle: () => ({ text: "[]" }) },
    { name: "gemini_generate_image", description: "Generate an image from a text prompt", inputSchema: { properties: { prompt: { type: "string" } } }, handle: () => ({ blocks: [{ type: "image", data: makePng(16).toString("base64"), mimeType: "image/png" }] }) },
    {
      name: "gemini_start_deep_research",
      description: "Start a deep research task on a topic and return its chat id",
      inputSchema: { properties: { query: { type: "string" } }, required: ["query"] },
      handle: (args) => ({ text: JSON.stringify({ chat_id: "c_123", topic: args.query }) }),
    },
    {
      name: "gemini_research_status",
      description: "Check the status of a deep research task",
      inputSchema: { properties: { chat_id: { type: "string" } } },
      handle: () => {
        statusPolls++;
        return statusPolls < 2
          ? { text: JSON.stringify({ status: "running", progress: "searching" }) }
          : { text: JSON.stringify({ status: "completed", report: "# Coffee report\n\nFacts." }) };
      },
    },
    {
      name: "gemini_chat",
      description: "Send a prompt to Gemini and get a text reply",
      inputSchema: { properties: { prompt: { type: "string" } } },
      handle: (args) =>
        String(args.prompt).includes('"analysis"')
          ? { text: 'Analysis:\n```json\n{"analysis":"Coffee angle for Instagram","imagePrompt":"a cup of coffee"}\n```' }
          : { text: 'Here you go:\n```json\n{"caption":"Coffee hook #coffee","commentBody":"Details"}\n```' },
    },
    {
      name: "gemini_analyze_image",
      description: "Ask Gemini to look at an image and report problems",
      inputSchema: { properties: { image_base64: { type: "string" }, prompt: { type: "string" } } },
      handle: () => ({ text: JSON.stringify({ pass: false, issues: ["text garbled"], revisedPrompt: "clean cup" }) }),
    },
  ];
  const gFake = await startFakeMcp({ tools: geminiTools });
  const gServerTools = geminiTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const pick = resolve("gemini", gServerTools as any);
  assert.equal(pick.map.startResearch?.tool, "gemini_start_deep_research");
  assert.equal(pick.map.pollResearch?.tool, "gemini_research_status");
  assert.equal(pick.map.analyze?.tool, "gemini_chat");
  assert.equal(pick.map.caption?.tool, "gemini_chat");
  assert.equal(pick.map.verifyImage?.tool, "gemini_analyze_image");
  assert.equal(pick.map.generateImage?.tool, "gemini_generate_image");
  assert.deepEqual(pick.missing, []);
  ok("Gemini discovery picks the right tool for each operation and ignores decoys");

  const forced = resolve("gemini", gServerTools as any, parseToolMap('{"caption":"does_not_exist"}'));
  assert.deepEqual(forced.missing, ["caption"]);
  assert.throws(() => parseToolMap("not json"));
  ok("tool override: an unknown forced name is reported as missing; bad JSON is rejected");

  const cookieLoader = async () => "__Secure-1PSID=abc; __Secure-1PSIDTS=xyz";
  const gemini = createGemini({ url: () => gFake.url, toolMap: () => undefined, cookie: cookieLoader });
  const ref = await gemini.startResearch("coffee");
  assert.equal(ref.ref, "c_123");
  assert.equal(gFake.calls[0].args.query, "coffee");
  assert.equal(gFake.calls[0].cookie, "__Secure-1PSID=abc; __Secure-1PSIDTS=xyz", "cookie must reach the server");
  const p1 = await gemini.pollResearch(ref.ref);
  assert.equal(p1.status, "running");
  const p2 = await gemini.pollResearch(ref.ref);
  assert.equal(p2.status, "done");
  assert.equal(p2.report, "# Coffee report\n\nFacts.");
  ok("Gemini research: start returns the chat id, poll goes running then done with the report");

  const analysed = await gemini.analyze({ topic: "coffee", report: "# Coffee report" });
  assert.equal(analysed.analysis, "Coffee angle for Instagram");
  assert.equal(analysed.imagePrompt, "a cup of coffee");
  const analysisCall = gFake.calls
    .filter((c) => c.name === "gemini_chat")
    .find((c) => String(c.args.prompt).includes('"analysis"'))!;
  assert.ok(String(analysisCall.args.prompt).includes("Topic: coffee") && String(analysisCall.args.prompt).includes("# Coffee report"));
  ok("Gemini analysis: prompt carries topic and report; fenced JSON reply parsed");

  const made = await gemini.caption({ topic: "coffee", analysis: analysed.analysis });
  assert.equal(made.caption, "Coffee hook #coffee");
  assert.equal(made.commentBody, "Details");
  ok("Gemini caption: hook with hashtags and the pinned comment text parsed from the reply");

  const image = Buffer.from("fake-jpeg-bytes");
  const verdict = await gemini.verifyImage({ topic: "coffee", imagePrompt: analysed.imagePrompt, image, mimeType: "image/jpeg", attempt: 1 });
  assert.deepEqual(verdict, { pass: false, issues: ["text garbled"], revisedPrompt: "clean cup" });
  const analyzeCall = gFake.calls.find((c) => c.name === "gemini_analyze_image")!;
  assert.equal(analyzeCall.args.image_base64, image.toString("base64"));
  ok("Gemini verify: image sent as base64 with instructions; verdict normalised");

  const generated = await gemini.generateImage("a cup of coffee");
  assert.equal(generated.mimeType, "image/png");
  assert.ok(generated.bytes.length > 100);
  assert.equal(gFake.calls.filter((c) => c.name === "gemini_generate_image").at(-1)!.args.prompt, "a cup of coffee");
  ok("Gemini image: generated through the Gemini MCP tool and returned as bytes");

  const noCookie = createGemini({ url: () => gFake.url, toolMap: () => undefined, cookie: async () => null });
  const started = await noCookie.startResearch("x");
  assert.equal(started.ref, "c_123");
  assert.equal(gFake.calls.at(-1)!.cookie, undefined, "no cookie header when none is saved");
  ok("Gemini works without saved cookies (server keeps its own session); no cookie header is sent");

  const health = await createGemini({ url: () => gFake.url, toolMap: () => undefined, cookie: cookieLoader }).health();
  assert.equal(health.ok, true);
  assert.ok(String((health.details as any).mapping.caption).startsWith("gemini_chat"));
  const partial = await startFakeMcp({ tools: geminiTools.filter((t) => t.name !== "gemini_analyze_image") });
  const partialHealth = await createGemini({ url: () => partial.url, toolMap: () => undefined, cookie: cookieLoader }).health();
  assert.equal(partialHealth.ok, false);
  assert.ok(partialHealth.message.includes("verifyImage"));
  await partial.close();
  ok("health: full server reports the mapping; a server missing a tool says exactly which operation is unmapped");

  // ---------- ChatGPT MCP: image as content block, and as a URL ----------
  const pngBytes = makePng(32);
  const chatFake = await startFakeMcp({
    files: { "/img.png": { type: "image/png", body: pngBytes } },
    tools: [
      {
        name: "chatgpt_make_image",
        description: "Generate an image from a prompt",
        inputSchema: { properties: { prompt: { type: "string" } } },
        handle: () => ({ blocks: [{ type: "image", data: pngBytes.toString("base64"), mimeType: "image/png" }] }),
      },
      {
        name: "chatgpt_chat",
        description: "Chat with ChatGPT about anything",
        inputSchema: { properties: { message: { type: "string" } } },
        handle: () => ({ text: "hi" }),
      },
    ],
  });
  const chatgpt = createChatGpt({ url: () => chatFake.url, toolMap: () => undefined, cookie: cookieLoader });
  const fromBlock = await chatgpt.generateImage("a red cube");
  assert.ok(fromBlock.bytes.equals(pngBytes));
  assert.equal(fromBlock.mimeType, "image/png");
  assert.equal(chatFake.calls.find((c) => c.name === "chatgpt_make_image")!.args.prompt, "a red cube");
  ok("ChatGPT: image returned as an MCP image block is decoded to the same bytes");
  await chatFake.close();

  const urlFake = await startFakeMcp({
    files: { "/img.png": { type: "image/png", body: pngBytes } },
    tools: [
      {
        name: "chatgpt_make_image",
        description: "Generate an image from a prompt",
        inputSchema: { properties: { prompt: { type: "string" } } },
        handle: () => ({ text: `Here is your image: ${urlFake_url()}/img.png` }),
      },
    ],
  });
  const urlFake_url = () => urlFake.url.replace(/\/mcp$/, "");
  const fromUrl = await createChatGpt({ url: () => urlFake.url, toolMap: () => undefined, cookie: cookieLoader }).generateImage("a blue cube");
  assert.ok(fromUrl.bytes.equals(pngBytes));
  ok("ChatGPT: image URL in the reply is downloaded and returned as bytes");
  await urlFake.close();

  // ---------- research poll interpretation ----------
  assert.equal(interpretPoll('{"status":"in_progress"}').status, "running");
  assert.equal(interpretPoll('{"status":"done"}').status, "failed");
  assert.equal(interpretPoll('{"status":"failed","error":"quota"}').error, "quota");
  assert.equal(interpretPoll("Still researching the topic, please wait").status, "running");
  assert.equal(interpretPoll("x".repeat(400)).status, "done");
  ok("research poll replies: JSON and plain text interpreted as running, done or failed");

  // SSE replies: the same client must read a text/event-stream response
  const sseFake = await startFakeMcp({ sse: true, tools: [{ name: "instagram_pin_comment", inputSchema: { properties: {} }, handle: () => ({ text: "ok" }) }] });
  process.env.INSTAGRAM_MCP_URL = sseFake.url;
  const sseTools = await instagram.listTools();
  assert.deepEqual(sseTools.map((t) => t.name), ["instagram_pin_comment"]);
  await sseFake.close();
  ok("MCP client reads event-stream (SSE) replies as well as JSON");

  await gFake.close();
  console.log(`\nALL ${passed} SELF-TESTS PASSED`);
}

main().catch((err) => {
  console.error("SELF-TEST FAILED:", err);
  process.exit(1);
});
