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
        handle: () => ({ text: "{'status': 'success', 'media_id': '17900000001', 'url': 'https://www.instagram.com/p/AbC/', 'paced_seconds': 0}" }),
      },
      {
        name: "instagram_comment_on_post",
        inputSchema: { properties: { media_id_or_url: { type: "string" }, text: { type: "string" } }, required: ["media_id_or_url", "text"] },
        handle: () => ({ text: "{'status': 'success', 'comment_id': '17800000002', 'media_id_or_url': '17900000001', 'paced_seconds': 0}" }),
      },
      {
        name: "instagram_pin_comment",
        inputSchema: { properties: { comment_id: { type: "string" }, media_id_or_url: { type: "string" }, pin: { type: "boolean" } }, required: ["comment_id", "media_id_or_url"] },
        handle: () => ({ text: "Comment 17800000002 pinned on post 17900000001 (paced 0s)." }),
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

  // The real server answers errors as plain text with isError false, so the adapter must read the text.
  const badFake = await startFakeMcp({
    key: "good-key",
    tools: [
      {
        name: "instagram_post_photo",
        inputSchema: { properties: { caption: { type: "string" }, image_path_or_url: { type: "string" } }, required: ["caption", "image_path_or_url"] },
        handle: () => ({ text: "Error while posting the photo: challenge_required" }),
      },
      {
        name: "instagram_comment_on_post",
        inputSchema: { properties: { media_id_or_url: { type: "string" }, text: { type: "string" } }, required: ["media_id_or_url", "text"] },
        handle: () => ({ text: "Comments are disabled on that post." }),
      },
      {
        name: "instagram_pin_comment",
        inputSchema: { properties: { comment_id: { type: "string" }, media_id_or_url: { type: "string" }, pin: { type: "boolean" } }, required: ["comment_id", "media_id_or_url"] },
        handle: () => ({ text: "Comment 17800000002 unpinned on post 17900000001 (paced 0s)." }),
      },
    ],
  });
  process.env.INSTAGRAM_MCP_URL = `${badFake.url}?auth=good-key`;
  await assert.rejects(() => instagram.postPhoto({ imageUrl: "https://app.example.com/x", caption: "hi" }), /did not post the photo: Error while posting/);
  await assert.rejects(() => instagram.comment({ mediaId: "17900000001", text: "x" }), /did not post the comment: Comments are disabled/);
  await assert.rejects(() => instagram.pin({ commentId: "17800000002", mediaId: "17900000001" }), /did not pin the comment: Comment 17800000002 unpinned/);
  await badFake.close();
  ok("Instagram: error text is an error even though the call succeeds; an unpin is not a pin");

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

  // ---------- the account's models, from the Gemini server ----------
  const { parseAccountModels } = await import("@/lib/adapters/ai-mcp");
  const modelsFake = await startFakeMcp({
    tools: [
      {
        name: "gemini_list_models",
        description: "The Gemini models this account can use.",
        inputSchema: { properties: {} },
        handle: () => ({
          text: JSON.stringify({
            models: [
              { name: "gemini-pro", display_name: "Pro", available: true },
              { name: "gemini-flash-advanced", display_name: "Flash Advanced", available: false },
            ],
            verified: true,
            verified_at: "2026-10-18T10:00:00Z",
          }),
        }),
      },
    ],
  });
  const listed = await createGemini({ url: () => modelsFake.url, toolMap: () => undefined, cookie: async () => null }).models();
  assert.deepEqual(listed.models.map((m) => m.name), ["gemini-pro", "gemini-flash-advanced"]);
  assert.equal(listed.models[1].available, false, "a model the account cannot use is listed but marked");
  assert.equal(listed.verifiedAt, "2026-10-18T10:00:00Z");
  await modelsFake.close();

  const noList = await startFakeMcp({ tools: geminiTools });
  const none = await createGemini({ url: () => noList.url, toolMap: () => undefined, cookie: async () => null }).models();
  assert.equal(none.models.length, 0);
  assert.match(none.message ?? "", /does not report its models/);
  await noList.close();
  assert.equal(parseAccountModels("not json").models.length, 0);
  ok("models: the account's list comes from the server's own tool; a server without it says so, and nothing is guessed");

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

  // ---------- background driver: auth and which jobs it may run ----------
  const { cronAuthorized, NOT_TICKED } = await import("@/lib/jobs/tick");
  const { RUNNABLE, STATES } = await import("@/lib/jobs/states");
  const secret = randomBytes(24).toString("base64url");
  assert.equal(cronAuthorized(`Bearer ${secret}`, secret), true);
  assert.equal(cronAuthorized(`Bearer ${secret}x`, secret), false, "a longer token is refused");
  assert.equal(cronAuthorized(`Bearer ${secret.slice(1)}`, secret), false, "a shorter token is refused");
  assert.equal(cronAuthorized(secret, secret), false, "the bare secret without 'Bearer' is refused");
  assert.equal(cronAuthorized(null, secret), false, "no header is refused");
  assert.equal(cronAuthorized(`Bearer ${"a".repeat(24)}`, "short"), false, "a secret under 16 characters is never accepted");
  assert.equal(cronAuthorized(`Bearer ${undefined}`, undefined), false, "an unset secret is never accepted");
  ok("cron tick: exact bearer secret only; unset or short secrets are refused");

  // The SQL in tickOnce lists the states it skips. They must be exactly the non-runnable ones.
  const notRunnable = STATES.filter((s) => !RUNNABLE.includes(s)).sort();
  assert.deepEqual([...NOT_TICKED].sort(), notRunnable);
  ok("cron tick: skips exactly the states the runner will not run (awaiting_review, done, failed)");

  // ---------- job start times ----------
  const { parseStart } = await import("@/lib/jobs/schedule");
  const now = new Date("2026-10-18T00:00:00Z");
  assert.deepEqual(parseStart(undefined, now), { at: null }, "no start time means now");
  assert.deepEqual(parseStart("", now), { at: null }, "an empty start time means now");
  const later = parseStart("2026-10-18T06:30:00Z", now);
  assert.ok("at" in later && later.at?.toISOString() === "2026-10-18T06:30:00.000Z");
  assert.ok("error" in parseStart("not a date", now), "garbage is refused");
  assert.ok("error" in parseStart(12345, now), "a non-string is refused");
  assert.ok("error" in parseStart("2028-01-01T00:00:00Z", now), "more than a year ahead is refused");
  const past = parseStart("2026-10-01T00:00:00Z", now);
  assert.ok("at" in past, "a past time is accepted (it starts at once)");
  ok("job start times: empty means now, garbage and far-future times are refused");

  // ---------- per-task models ----------
  const { normalizeModels, defaultModels } = await import("@/lib/settings");
  const { keysOf } = await import("@/lib/adapters/ai-mcp");
  assert.deepEqual(normalizeModels({ research: "gemini-pro", caption: "" }), { ...defaultModels(), research: "gemini-pro" });
  assert.deepEqual(normalizeModels({ unknown: "x" }), defaultModels(), "unknown keys are ignored");
  assert.throws(() => normalizeModels({ image: "gemini pro; rm -rf" }), /not a valid model name/);
  assert.throws(() => normalizeModels({ image: 5 }), /must be text/);
  assert.throws(() => normalizeModels(null), /one entry per task/);
  ok("models: names validated; blank means the account default; unknown keys ignored");

  const modelTool = (takesModel: boolean): FakeTool => ({
    name: "gemini_ask",
    description: "Ask Gemini a question",
    inputSchema: { properties: takesModel ? { prompt: { type: "string" }, model: { type: "string" } } : { prompt: { type: "string" } } },
    handle: () => ({ text: '{"analysis":"ok","imagePrompt":"img"}' }),
  });
  const withArg = await startFakeMcp({ tools: [modelTool(true)] });
  const withoutArg = await startFakeMcp({ tools: [modelTool(false)] });
  try {
    const pinned = createGemini({ url: () => withArg.url, toolMap: () => '{"analyze":"gemini_ask"}', cookie: async () => null });
    await pinned.analyze({ topic: "t", report: "r", model: "gemini-flash" });
    assert.equal(withArg.calls.at(-1)!.args.model, "gemini-flash", "the chosen model reaches a tool that takes one");
    await pinned.analyze({ topic: "t", report: "r" });
    assert.equal(withArg.calls.at(-1)!.args.model, undefined, "no model argument when none is chosen");
    const plain = createGemini({ url: () => withoutArg.url, toolMap: () => '{"analyze":"gemini_ask"}', cookie: async () => null });
    await plain.analyze({ topic: "t", report: "r", model: "gemini-flash" });
    assert.equal("model" in withoutArg.calls.at(-1)!.args, false, "a tool without a model argument is never sent one");
    assert.equal(keysOf(modelTool(true) as any).model, "model");
    ok("models reach the server only when the tool takes a model argument");
  } finally {
    await withArg.close();
    await withoutArg.close();
  }

  // ---------- server checks ----------
  const chatReply = { text: "OK" };
  const chatServer = await startFakeMcp({
    tools: [
      {
        name: "gemini_ask",
        description: "Ask Gemini a question",
        inputSchema: { properties: { prompt: { type: "string" } } },
        handle: () => ({ text: chatReply.text }),
      },
    ],
  });
  try {
    const sessionClient = createGemini({ url: () => chatServer.url, toolMap: () => '{"analyze":"gemini_ask"}', cookie: async () => null });
    assert.equal((await sessionClient.session()).ok, true, "a Gemini reply means the session works");
    chatReply.text = "";
    assert.equal((await sessionClient.session()).ok, false, "an empty reply is not ready");
    ok("server checks: Gemini session is ready on a reply, not ready on an empty one");
  } finally {
    await chatServer.close();
  }
  const loginState = { loggedIn: true };
  const loginServer = await startFakeMcp({
    tools: [
      {
        name: "instagram_get_login_status",
        inputSchema: { properties: {} },
        handle: () => ({
          text: loginState.loggedIn
            ? "{'logged_in': True, 'username': 'alice', 'user_id': '1'}"
            : "{'logged_in': False, 'username': None, 'user_id': None}",
        }),
      },
    ],
  });
  const savedInstagramUrl = process.env.INSTAGRAM_MCP_URL;
  try {
    process.env.INSTAGRAM_MCP_URL = loginServer.url;
    const valid = await instagram.status();
    assert.equal(valid.ok, true);
    assert.equal(valid.username, "alice");
    loginState.loggedIn = false;
    const expired = await instagram.status();
    assert.equal(expired.ok, false);
    assert.match(expired.message, /Not logged in/);
    ok("server checks: a valid Instagram login reads as ready with the account; an expired one as not ready");
  } finally {
    process.env.INSTAGRAM_MCP_URL = savedInstagramUrl;
    await loginServer.close();
  }

  // ---------- report sent as a file ----------
  const report = "# Coffee report\n\nFacts about coffee, long enough to matter.";
  const takesFiles = (yes: boolean): FakeTool => ({
    name: "gemini_ask",
    description: "Ask Gemini a question",
    inputSchema: { properties: yes ? { prompt: { type: "string" }, attachments: { type: "array" } } : { prompt: { type: "string" } } },
    handle: () => ({ text: '{"analysis":"ok","imagePrompt":"img"}' }),
  });
  assert.equal(keysOf(takesFiles(true) as any).attachments, "attachments");
  assert.equal(keysOf(takesFiles(false) as any).attachments, undefined);
  const fileServer = await startFakeMcp({ tools: [takesFiles(true)] });
  const pasteServer = await startFakeMcp({ tools: [takesFiles(false)] });
  try {
    const sends = createGemini({ url: () => fileServer.url, toolMap: () => '{"analyze":"gemini_ask"}', cookie: async () => null });
    const attached = await sends.analyze({ topic: "coffee", report });
    const sentFile = fileServer.calls.at(-1)!;
    assert.equal(attached.reportVia, "attached");
    assert.deepEqual(sentFile.args.attachments, [{ name: "research-report.md", content_base64: Buffer.from(report).toString("base64") }]);
    assert.ok(String(sentFile.args.prompt).includes("attached as research-report.md"));
    assert.ok(!String(sentFile.args.prompt).includes("Facts about coffee"), "the report is not pasted into the prompt");

    const pastes = createGemini({ url: () => pasteServer.url, toolMap: () => '{"analyze":"gemini_ask"}', cookie: async () => null });
    const pasted = await pastes.analyze({ topic: "coffee", report });
    const sentPaste = pasteServer.calls.at(-1)!;
    assert.equal(pasted.reportVia, "pasted");
    assert.ok(String(sentPaste.args.prompt).includes("Facts about coffee"), "a server without attachments gets the report in the prompt");
    assert.equal("attachments" in sentPaste.args, false);
    ok("analysis: report sent as research-report.md when the tool takes files, pasted otherwise");
  } finally {
    await fileServer.close();
    await pasteServer.close();
  }

  // ---------- workflow switches and typed-in content ----------
  const { normalizeWorkflow, normalizeManual, missingManual, defaultWorkflow } = await import("@/lib/jobs/workflow");
  const { runStep } = await import("@/lib/jobs/steps");
  assert.deepEqual(normalizeWorkflow(undefined), defaultWorkflow(), "no switches means every step runs");
  assert.equal(normalizeWorkflow({ skipVerify: true, nonsense: 1 }).skipVerify, true, "unknown keys are ignored");
  assert.throws(() => normalizeWorkflow({ skipVerify: "yes" }), /must be true or false/, "a non-boolean switch is refused");
  assert.deepEqual(normalizeManual({ report: "  hello  ", caption: "   " }), { report: "hello" });
  assert.throws(() => normalizeManual({ caption: "x".repeat(2201) }), /longer than/);
  assert.match(missingManual({ ...defaultWorkflow(), skipResearch: true }, {}) ?? "", /Paste the research report/);
  assert.equal(missingManual({ ...defaultWorkflow(), skipResearch: true }, { report: "r" }), null);
  ok("workflow: switches must be true or false; typed text is trimmed and length-checked; a skipped step needs its text");

  const jobWith = (state: string, data: Record<string, unknown>, attempts = 1) =>
    ({
      id: "11111111-1111-4111-8111-111111111111",
      topic: "coffee",
      state,
      busy: true,
      attempts,
      data,
      error: null,
      scheduled_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    }) as any;

  const noVerify = await runStep(jobWith("verifying", { workflow: { ...defaultWorkflow(), skipVerify: true }, draftPath: "drafts/none/1" }));
  assert.equal(noVerify.state, "captioning");
  assert.equal((noVerify.data?.verdict as any).skipped, true);
  ok("skip image check: goes straight to the caption, marked as skipped");

  const noAnalysis = await runStep(
    jobWith("analyzing", { workflow: { ...defaultWorkflow(), skipAnalysis: true }, report: "# Report body", manual: { imagePrompt: "a cup", analysis: "the angle" } }),
  );
  assert.equal(noAnalysis.state, "generating");
  assert.equal(noAnalysis.data?.imagePrompt, "a cup");
  assert.equal(noAnalysis.data?.analysis, "the angle");
  ok("skip analysis: your image prompt and analysis text are used, with no Gemini chat");

  const waiting = await runStep(jobWith("generating", { workflow: { ...defaultWorkflow(), skipImage: true }, imagePrompt: "a cup" }));
  assert.equal(waiting.state, "generating");
  assert.equal(waiting.pending, true);
  assert.equal(waiting.quiet, true, "waiting for an upload is not logged on every poll");
  const uploaded = await runStep(
    jobWith("generating", { workflow: { ...defaultWorkflow(), skipImage: true }, uploadedDraftPath: "drafts/x/2", imagePrompt: "a cup" }, 1),
  );
  assert.equal(uploaded.state, "verifying");
  assert.equal(uploaded.attempts, 2);
  assert.equal(uploaded.data?.draftPath, "drafts/x/2");
  ok("skip image: waits quietly for an upload, then goes on to the check with that picture");

  const bothSkips = { ...defaultWorkflow(), skipCaption: true, skipApproval: true };
  const posted = await runStep(
    jobWith("captioning", {
      workflow: bothSkips,
      imagePrompt: "a cup",
      verdict: { pass: true, issues: [], skipped: true },
      manual: { caption: "Hook text #coffee", commentBody: "Full details here" },
    }),
  );
  assert.equal(posted.state, "publishing");
  assert.ok((posted.data?.plan as any).caption.startsWith("Hook text #coffee"));
  assert.equal((posted.data?.plan as any).commentBody, "Full details here");
  const held = await runStep(
    jobWith("captioning", {
      workflow: { ...defaultWorkflow(), skipCaption: true },
      imagePrompt: "a cup",
      manual: { caption: "Hook", commentBody: "Body" },
      verdict: { pass: true, issues: [] },
    }),
  );
  assert.equal(held.state, "awaiting_review", "without Skip approval the job waits for you");
  const failedCheck = await runStep(
    jobWith("captioning", { workflow: bothSkips, imagePrompt: "a cup", manual: { caption: "Hook", commentBody: "Body" }, verdict: { pass: false, issues: ["x"] } }),
  );
  assert.equal(failedCheck.state, "awaiting_review", "a failed check still stops for you, even with Skip approval");
  ok("skip caption and skip approval: your caption posts at once; a failed check still stops for you");

  // ---------- carousel: slide count, plan, slide prompts, check ----------
  const carousel = await import("@/lib/jobs/carousel");
  assert.equal(carousel.CAROUSEL_DEFAULT, 8);
  assert.deepEqual([carousel.CAROUSEL_MIN, carousel.CAROUSEL_MAX], [3, 10]);
  assert.equal(carousel.clampSlideCount(8), 8);
  assert.equal(carousel.clampSlideCount("7"), 7, "a number typed into a form arrives as text");
  for (const bad of [2, 11, 2.5, "abc", "", null, undefined]) {
    assert.throws(() => carousel.clampSlideCount(bad), /whole number from 3 to 10/, `refused: ${String(bad)}`);
  }
  ok("carousel slide count: whole numbers from 3 to 10 (default 8); anything else is refused");

  const planText = [
    "Here is the plan:",
    "```json",
    JSON.stringify({
      analysis: "  Coffee helps focus.  ",
      styleGuide: "Warm flat illustration.",
      slides: [
        { role: "point", headline: "Why coffee?", body: "A quick hook", imagePrompt: "a cup" },
        { role: "hook", headline: "Second", body: "", imagePrompt: "b" },
        { role: "weird", headline: "Third", body: "x", imagePrompt: "c" },
        { role: "cta", headline: "Save it", body: "", imagePrompt: "d" },
        { role: "point", headline: "Beyond the count", body: "", imagePrompt: "e" },
      ],
    }),
    "```",
  ].join("\n");
  const cPlan = carousel.parseCarouselPlan(planText, 4);
  assert.equal(cPlan.slides.length, 4, "keeps at most the number asked for");
  assert.deepEqual(cPlan.slides.map((s) => s.role), ["hook", "point", "point", "cta"], "the first slide is the hook; a second hook becomes a point; an unknown role becomes a point");
  assert.equal(cPlan.analysis, "Coffee helps focus.");
  assert.equal(cPlan.styleGuide, "Warm flat illustration.");
  assert.throws(() => carousel.parseCarouselPlan(JSON.stringify({ slides: [{ headline: "x" }, { imagePrompt: "y" }] }), 3), /no image prompt/);
  assert.throws(() => carousel.parseCarouselPlan(JSON.stringify({ slides: [{ imagePrompt: "only one" }] }), 3), /at least 2/);
  assert.throws(() => carousel.parseCarouselPlan("no json here", 3), /no JSON object/);
  ok("carousel plan: JSON read from a fenced reply, cut to the slide count; the first slide is always the hook");

  assert.deepEqual(
    carousel.slidesFromLines("\n  a cup of coffee  \n\nsteam rising\n\n", 8).map((s) => [s.role, s.imagePrompt]),
    [["hook", "a cup of coffee"], ["point", "steam rising"]],
  );
  assert.throws(() => carousel.slidesFromLines("only one", 8), /at least two lines/);
  assert.throws(() => carousel.slidesFromLines("a\nb\nc", 2), /3 image prompts, but this carousel has 2 slides/);
  ok("hand-written slides: one prompt per line, first line is the hook, blank lines ignored, too many refused");

  const hook = { role: "hook" as const, headline: "Why coffee helps", body: "Three facts", imagePrompt: "a cup on a desk" };
  const hookPrompt = carousel.slidePrompt("Flat illustration.", hook, { index: 0, total: 8 });
  assert.ok(hookPrompt.includes("Swipe for more"), "the hook asks the viewer to swipe");
  assert.ok(hookPrompt.includes('"Why coffee helps"') && hookPrompt.includes('"Three facts"'), "the headline and body are shown exactly");
  assert.ok(hookPrompt.includes("Slide 1 of 8") && hookPrompt.includes("Flat illustration."), "the position and the shared style are given");
  const point = carousel.slidePrompt("Flat illustration.", { role: "point", headline: "", body: "", imagePrompt: "steam" }, { index: 3, total: 8 }, ["text garbled."]);
  assert.ok(!point.includes("Swipe for more"), "only the hook asks to swipe");
  assert.ok(point.includes("Slide 4 of 8") && point.includes("Fix these problems: text garbled."), "a correction is added to the prompt");
  assert.equal(carousel.expectedText(hook), "Why coffee helps");
  assert.equal(carousel.expectedText(point), undefined, "a slide written by hand has no text to check");
  ok("slide prompts: the hook says swipe and shows its text; corrections are added; hand-written slides have no text to check");

  const img = (pass: boolean | undefined, issues?: string[]) => ({ attempt: 1, path: "drafts/x/1/1", tries: 1, pass, issues });
  assert.deepEqual(carousel.carouselVerdict([img(true), img(true)], 2, false), { pass: true, issues: [] });
  const mixed = carousel.carouselVerdict([img(true), img(false, ["text garbled"]), img(true)], 3, false);
  assert.equal(mixed.pass, false);
  assert.deepEqual(mixed.issues, ["Slide 2: text garbled"], "each issue names its slide");
  const short = carousel.carouselVerdict([img(true)], 3, false);
  assert.equal(short.pass, false, "a slide that was never made fails the set");
  assert.deepEqual(short.issues, ["Slide 2: not made yet", "Slide 3: not made yet"]);
  assert.deepEqual(carousel.carouselVerdict([img(false)], 1, false).issues, ["Slide 1: failed the check"]);
  assert.deepEqual(carousel.carouselVerdict([], 3, true), { pass: true, issues: [], skipped: true });
  ok("carousel check: passes only when every slide passes; each issue names its slide; a missing slide fails");

  assert.match(carousel.carouselProblem("carousel", { ...defaultWorkflow(), skipImage: true }) ?? "", /cannot be skipped/);
  assert.equal(carousel.carouselProblem("carousel", defaultWorkflow()), null);
  assert.equal(carousel.carouselProblem("post", { ...defaultWorkflow(), skipImage: true }), null, "a single post can still take an uploaded picture");
  ok("carousel: skipping image generation is refused; a single post may still skip it");

  // Gemini: the plan request carries the chosen count and the report file; the reply is cut to that count.
  const planReply = JSON.stringify({
    analysis: "Coffee angle",
    styleGuide: "Warm flat illustration.",
    slides: Array.from({ length: 9 }, (_, i) => ({
      role: i === 0 ? "hook" : i === 8 ? "cta" : "point",
      headline: `Slide ${i + 1} headline`,
      body: "",
      imagePrompt: `picture ${i + 1}`,
    })),
  });
  const askFake = await startFakeMcp({
    tools: [
      {
        name: "gemini_ask",
        description: "Ask Gemini a question",
        inputSchema: { properties: { prompt: { type: "string" }, attachments: { type: "array" } } },
        handle: () => ({ text: planReply }),
      },
      {
        name: "gemini_analyze_image",
        description: "Ask Gemini to look at an image and report problems",
        inputSchema: { properties: { image_base64: { type: "string" }, prompt: { type: "string" } } },
        handle: () => ({ text: JSON.stringify({ pass: true, issues: [] }) }),
      },
    ],
  });
  try {
    const cg = createGemini({
      url: () => askFake.url,
      toolMap: () => '{"analyze":"gemini_ask","verifyImage":"gemini_analyze_image"}',
      cookie: async () => null,
    });
    const cp = await cg.analyzeCarousel({ topic: "coffee", report: "# Coffee report\n\nFacts.", slideCount: 8 });
    assert.equal(cp.slides.length, 8, "the plan is cut to the number of slides chosen");
    assert.equal(cp.slides[0].role, "hook");
    const sent = askFake.calls.at(-1)!;
    assert.ok(String(sent.args.prompt).includes("Topic: coffee"));
    assert.ok(String(sent.args.prompt).includes("at most 8"), "the prompt carries the chosen slide count");
    assert.ok(String(sent.args.prompt).includes("exactly 1:1"), "the prompt carries the picture rules");
    assert.ok(String(sent.args.prompt).includes("NO LOGO"), "the prompt forbids logos before any prompt is written");
    assert.ok(String(sent.args.prompt).includes("under 400 characters"), "the prompt states the length limit");
    assert.ok(String(sent.args.prompt).includes("1000 characters"), "the prompt states the tool's limit");
    assert.deepEqual(sent.args.attachments, [{ name: "research-report.md", content_base64: Buffer.from("# Coffee report\n\nFacts.").toString("base64") }]);
    assert.equal((await cg.analyzeCarousel({ topic: "coffee", report: "r", slideCount: 3 })).slides.length, 3);
    ok("carousel analysis: the chosen count and the report file go to Gemini; the reply is cut to that count");

    const withHeadline = await cg.verifyImage({ topic: "coffee", imagePrompt: "a cup", image: Buffer.from("x"), mimeType: "image/png", attempt: 1, expectedText: "Why coffee helps" });
    assert.equal(withHeadline.pass, true);
    assert.ok(String(askFake.calls.at(-1)!.args.prompt).includes('exactly as written: "Why coffee helps"'), "the headline is part of the check");
    await cg.verifyImage({ topic: "coffee", imagePrompt: "a cup", image: Buffer.from("x"), mimeType: "image/png", attempt: 1 });
    assert.equal(String(askFake.calls.at(-1)!.args.prompt).includes("exactly as written"), false, "no text check without a headline");
    assert.equal(String(askFake.calls.at(-1)!.args.prompt).includes("{extra}"), false, "no placeholder is left in the prompt");
    ok("carousel check: a slide's headline is checked as written; slides without one are not");
  } finally {
    await askFake.close();
  }

  // Instagram: the album goes out as one post with its pictures in order.
  const albumFake = await startFakeMcp({
    tools: [
      {
        name: "instagram_post_album",
        inputSchema: { properties: { image_paths_or_urls: { type: "array" }, caption: { type: "string" }, aspect: { type: "string" }, disable_comments: { type: "boolean" } }, required: ["image_paths_or_urls", "caption"] },
        handle: () => ({ text: "{'status': 'success', 'media_id': '17900000009', 'url': 'https://www.instagram.com/p/Car/', 'items': 2}" }),
      },
    ],
  });
  const savedAlbumUrl = process.env.INSTAGRAM_MCP_URL;
  try {
    process.env.INSTAGRAM_MCP_URL = albumFake.url;
    const pics = ["https://app.example.com/a", "https://app.example.com/b"];
    const album = await instagram.postAlbum({ imageUrls: pics, caption: "Swipe" });
    assert.equal(album.mediaId, "17900000009");
    assert.deepEqual(albumFake.calls.at(-1)!.args, { image_paths_or_urls: pics, caption: "Swipe", aspect: "square", disable_comments: false });
    await assert.rejects(() => instagram.postAlbum({ imageUrls: [pics[0]], caption: "x" }), /2 to 10 pictures/);
    await assert.rejects(() => instagram.postAlbum({ imageUrls: Array.from({ length: 11 }, (_, i) => `https://app.example.com/${i}`), caption: "x" }), /2 to 10 pictures/);
    ok("Instagram carousel: the pictures go in order as one album; fewer than 2 or more than 10 is refused");
  } finally {
    process.env.INSTAGRAM_MCP_URL = savedAlbumUrl;
    await albumFake.close();
  }

  // ---------- carousel: formats, saved count, storage, links, steps ----------
  assert.equal(carousel.parseFormat(undefined), "post", "no format means a single post");
  assert.equal(carousel.parseFormat("carousel"), "carousel");
  assert.throws(() => carousel.parseFormat("reel"), /must be "post" or "carousel"/);
  const { normalizeCarousel, defaultCarousel } = await import("@/lib/settings");
  assert.deepEqual(defaultCarousel(), { slideCount: 8 });
  assert.deepEqual(normalizeCarousel({}), { slideCount: 8 });
  assert.deepEqual(normalizeCarousel({ slideCount: "5" }), { slideCount: 5 });
  assert.throws(() => normalizeCarousel({ slideCount: 12 }), /whole number from 3 to 10/);
  ok("carousel formats and the saved count: missing means a post and 8 slides; out of range is refused");

  const { draftPath } = await import("@/lib/blob");
  assert.equal(draftPath("job", 4), "drafts/job/4", "a single post keeps its path");
  assert.equal(draftPath("job", 4, 2), "drafts/job/4-2", "each carousel slide has its own picture");
  const slideUrl = new URL(publicMediaUrl(jobId, 4, 2));
  assert.equal(slideUrl.searchParams.get("slide"), "2");
  const slideExp = Number(slideUrl.searchParams.get("exp"));
  const slideSig = slideUrl.searchParams.get("sig")!;
  assert.equal(verifyMediaSignature(jobId, 4, slideExp, slideSig, 2), true);
  assert.equal(verifyMediaSignature(jobId, 4, slideExp, slideSig, 3), false, "a slide's link does not open another slide");
  assert.equal(verifyMediaSignature(jobId, 4, slideExp, slideSig), false, "a slide's link does not open the single-post picture");
  ok("storage and links: each slide has its own path and signed link; no link opens another slide");

  assert.match(missingManual({ ...defaultWorkflow(), skipAnalysis: true }, {}, "carousel") ?? "", /one image prompt per line/);
  assert.equal(missingManual({ ...defaultWorkflow(), skipAnalysis: true }, { slides: "a\nb" }, "carousel"), null);
  assert.match(missingManual({ ...defaultWorkflow(), skipAnalysis: true }, {}) ?? "", /Write the image prompt/);
  ok("hand-written carousel: its slides are asked for, not a single image prompt");

  const { afterCheck } = await import("@/lib/jobs/carousel-steps");
  const pic = (tries: number, pass?: boolean, issues: string[] = []) => ({ attempt: 1, path: "p", tries, pass, issues });
  const wfAll = defaultWorkflow();
  const failing = { pass: false, issues: ["text garbled"], revisedPrompt: "a clean cup" };
  const retry = afterCheck(1, 3, pic(1, false, ["text garbled"]), failing, [pic(1, true), pic(1, false, ["text garbled"])], wfAll);
  assert.equal(retry.state, "generating", "a first failure makes the same slide again");
  assert.equal(retry.data?.slideIndex, 1);
  assert.deepEqual(retry.data?.slideFix, { index: 1, notes: ["text garbled"], imagePrompt: "a clean cup" });
  const moved = afterCheck(1, 3, pic(2, false, ["text garbled"]), failing, [pic(1, true), pic(2, false, ["text garbled"])], wfAll);
  assert.equal(moved.state, "generating");
  assert.equal(moved.data?.slideIndex, 2, "after a second failure the job moves on to the next slide");
  assert.equal(moved.data?.slideFix, null);
  const lastFail = afterCheck(2, 3, pic(2, false, ["text garbled"]), failing, [pic(1, true), pic(1, true), pic(2, false, ["text garbled"])], wfAll);
  assert.equal(lastFail.state, "captioning", "after the last slide the caption comes next, even when a slide failed");
  assert.equal((lastFail.data?.verdict as any).pass, false);
  assert.deepEqual((lastFail.data?.verdict as any).issues, ["Slide 3: text garbled"]);
  const lastPass = afterCheck(2, 3, pic(1), { pass: true, issues: [] }, [pic(1, true), pic(1, true), pic(1, true)], wfAll);
  assert.equal(lastPass.state, "captioning");
  assert.equal((lastPass.data?.verdict as any).pass, true);
  ok("carousel check decisions: one correction per slide, then on; the set's verdict names the failed slide");

  // The carousel steps that need no picture storage run here. Picture generation and reading back the
  // drafts need Vercel Blob, so they are checked on the live app.
  const cPlanOf = (n: number) => ({
    analysis: "a",
    styleGuide: "s",
    slides: Array.from({ length: n }, (_, k) => ({ role: k === 0 ? ("hook" as const) : ("point" as const), headline: `h${k + 1}`, body: "", imagePrompt: `p${k + 1}` })),
  });
  const handWritten = { ...defaultWorkflow(), skipAnalysis: true };
  const planned = await runStep(
    jobWith("analyzing", { format: "carousel", slideCount: 3, workflow: handWritten, report: "# r", manual: { slides: "hook line\npoint line\nlast line" } }),
  );
  assert.equal(planned.state, "generating");
  assert.equal((planned.data?.carousel as any).slides.length, 3);
  assert.equal((planned.data?.carousel as any).slides[0].role, "hook");
  assert.deepEqual(planned.data?.slideImages, []);
  assert.equal(planned.data?.slideIndex, 0);
  await assert.rejects(
    () => runStep(jobWith("analyzing", { format: "carousel", slideCount: 3, workflow: handWritten, report: "# r", manual: { slides: "one" } })),
    /at least two lines/,
  );
  ok("carousel analysis, skipped: your prompts become the slides, the first is the hook");

  const skipChecks = { ...defaultWorkflow(), skipVerify: true };
  const firstSlide = await runStep(
    jobWith("verifying", { format: "carousel", workflow: skipChecks, carousel: cPlanOf(2), slideIndex: 0, slideImages: [pic(1)] }),
  );
  assert.equal(firstSlide.state, "generating");
  assert.equal(firstSlide.data?.slideIndex, 1);
  assert.equal((firstSlide.data?.slideImages as any[])[0].pass, true);
  const lastSlide = await runStep(
    jobWith("verifying", { format: "carousel", workflow: skipChecks, carousel: cPlanOf(2), slideIndex: 1, slideImages: [pic(1, true), pic(1)] }),
  );
  assert.equal(lastSlide.state, "captioning");
  assert.equal((lastSlide.data?.verdict as any).skipped, true);
  ok("carousel check, skipped: each slide moves on, and the last one goes to the caption");

  const albumPlan = { plan: { caption: "c", commentBody: "b", imagePrompt: "i" } };
  const album = await runStep(
    jobWith("publishing", {
      format: "carousel",
      workflow: wfAll,
      ...albumPlan,
      carousel: cPlanOf(2),
      slideImages: [pic(1, true), pic(1, true)],
    }),
  );
  assert.equal(album.state, "publishing");
  assert.match((album.data?.publish as any).mediaId, /^mock-album-/);
  assert.match(album.note ?? "", /one album of 2 pictures/);
  await assert.rejects(
    () => runStep(jobWith("publishing", { format: "carousel", workflow: wfAll, ...albumPlan, carousel: cPlanOf(2), slideImages: [pic(1, true)] })),
    /has 1 of 2 pictures/,
  );
  ok("carousel publishing: all pictures go out as one album; a missing picture stops it with a clear message");

  // ---------- quick research: search, page check, sources in the post ----------
  const { parseResearchStyle, parseSearchReply, parseConfirmReply, keepConfirmed, citedSources, buildQuickReport, withSources } = await import(
    "@/lib/jobs/quick"
  );
  const { fetchSource, htmlToText } = await import("@/lib/sources");

  assert.equal(parseResearchStyle(undefined), "deep");
  assert.equal(parseResearchStyle("quick"), "quick");
  assert.throws(() => parseResearchStyle("fast"), /"deep" or "quick"/);
  ok("research style: missing means deep; only deep or quick are accepted");

  const search = parseSearchReply(
    JSON.stringify({
      summary: "S",
      points: [
        { claim: "Fact A", url: "https://a.example/x", title: "Page A" },
        { claim: "No address", url: "", title: "Nope" },
        { claim: "Not web", url: "ftp://files.example/x", title: "Ftp" },
        { claim: "Fact B", url: "https://b.example/y", title: "" },
      ],
    }),
  );
  assert.deepEqual(search.points.map((p) => p.claim), ["Fact A", "Fact B"]);
  assert.equal(search.points[1].title, "https://b.example/y", "a missing title falls back to the address");
  assert.throws(() => parseSearchReply('{"points":[]}'), /no facts with web addresses/);
  ok("search reply: facts without a web address are dropped; a missing title falls back to the address");

  const otherKeys = parseSearchReply(
    JSON.stringify({ facts: [{ fact: "Coffee contains caffeine", source: "https://c.example/p" }] }),
  );
  assert.equal(otherKeys.points.length, 1, "other key names for facts and addresses are read");
  const sourceList = parseSearchReply(
    JSON.stringify({ points: [{ claim: "Tea has less caffeine than coffee", sources: [{ url: "https://t.example/q" }] }] }),
  );
  assert.equal(sourceList.points[0].url, "https://t.example/q", "an address from a list of sources is used");
  const prose = parseSearchReply(
    "Here is what I found.\n- RAG combines retrieval with generation (https://en.example/rag).\nThanks.",
  );
  assert.equal(prose.points.length, 1, "a line with a web address in plain text gives a fact");
  assert.equal(prose.points[0].url, "https://en.example/rag");
  assert.throws(
    () => parseSearchReply("I cannot browse the web right now."),
    /Gemini replied: "I cannot browse the web right now\."/,
    "the error shows what Gemini replied",
  );
  ok("search reply: other key names, lists of sources and plain text with addresses are read; a failure shows the reply");

  const checked = parseConfirmReply(
    JSON.stringify({
      checks: [
        { claim: "Fact A", url: "https://a.example/x", supported: true, reason: "the page says so" },
        { claim: "Fact B", url: "https://b.example/y", supported: "false", reason: "not on the page" },
      ],
    }),
    search.points,
  );
  assert.equal(checked[0].supported, true);
  assert.equal(checked[0].title, "Page A", "the title comes from the search, not from the checker");
  assert.equal(checked[1].supported, false, "only a yes counts as supported");
  const yesWords = parseConfirmReply(
    JSON.stringify({ checks: [{ claim: "Fact A", url: "https://a.example/x/", supported: "Yes", reason: "ok" }] }),
    search.points,
  );
  assert.equal(yesWords[0].supported, true, "a yes written as 'Yes' counts");
  assert.equal(yesWords[0].url, "https://a.example/x", "an altered address is matched by its claim");
  assert.equal(yesWords[0].title, "Page A");
  ok("fact check reply: 'Yes' counts as supported, and a check with an altered address is matched to its fact");
  const kept = keepConfirmed(
    [...checked, { claim: "Fact C", url: "https://c.example/z", title: "C", supported: true }],
    new Set(["https://a.example/x"]),
  );
  assert.deepEqual(kept.map((k) => k.claim), ["Fact A"], "a fact is kept only when supported and its page could be read");
  const cited = citedSources(kept);
  assert.deepEqual(cited, [{ url: "https://a.example/x", title: "Page A" }]);
  const checkedReport = buildQuickReport("Coffee", kept);
  assert.ok(checkedReport.includes("# Checked facts: Coffee") && checkedReport.includes("- Fact A ([Page A](https://a.example/x))"), checkedReport);
  ok("checked facts: only supported facts with a readable page are kept; the report and sources list them");

  const withBlock = withSources("Body text", cited);
  assert.ok(withBlock.startsWith("Body text") && withBlock.includes("Sources, checked before posting:") && withBlock.includes("https://a.example/x"));
  assert.equal(withSources("Plain", undefined), "Plain", "no sources: the comment is unchanged");
  assert.ok(withSources("x".repeat(3000), cited).length <= 2200, "the comment stays within the limit");
  assert.ok(withSources("x".repeat(3000), cited).includes("https://a.example/x"), "the sources survive a long comment");
  ok("pinned comment: sources added at the end, and the whole comment stays within the limit");

  const local = await fetchSource("http://127.0.0.1:9/page", "Local");
  assert.equal(local.ok, false);
  assert.match(local.error ?? "", /private network/);
  const localName = await fetchSource("http://localhost/page", "Local");
  assert.equal(localName.ok, false);
  const notWeb = await fetchSource("ftp://example.com/file", "Ftp");
  assert.equal(notWeb.ok, false);
  assert.equal(
    htmlToText("<html><script>var x=1</script><p>Coffee &amp; tea</p><style>p{}</style><p>Ok</p></html>"),
    "Coffee & tea Ok",
  );
  ok("sources: private, local and non-web addresses are refused without a request; page text drops scripts and tags");

  const quickFake = await startFakeMcp({
    tools: [
      {
        name: "gemini_chat",
        description: "Ask Gemini a question in a chat.",
        inputSchema: { properties: { prompt: { type: "string" }, model: { type: "string" } }, required: ["prompt"] },
        handle: (args) => ({
          text: String(args.prompt).includes("exactly these keys")
            ? JSON.stringify({ summary: "Two sources agree.", points: [{ claim: "Fact A", url: "https://a.example/x", title: "Page A" }] })
            : JSON.stringify({ checks: [{ claim: "Fact A", url: "https://a.example/x", supported: true, reason: "the page says so" }] }),
        }),
      },
    ],
  });
  const quickGemini = createGemini({ url: () => quickFake.url, toolMap: () => undefined, cookie: async () => null });
  const found = await quickGemini.search({ topic: "coffee" });
  assert.equal(found.points.length, 1);
  assert.match(String(quickFake.calls[0].args.prompt), /exactly these keys/);
  const verdicts = await quickGemini.confirm({
    topic: "coffee",
    points: found.points,
    sources: [{ url: "https://a.example/x", title: "Page A", text: "Page text about Fact A" }],
  });
  assert.equal(verdicts[0].supported, true);
  assert.match(String(quickFake.calls.at(-1)!.args.prompt), /Page text about Fact A/, "the check sends the page text");
  await quickFake.close();
  ok("Gemini quick research: search returns facts with web addresses; the check sends the page text and reads the verdict");

  // ---------- quick research steps in mock mode ----------
  const quickJob = (state: string, data: Record<string, unknown>) => jobWith(state, { research: "quick", ...data });
  const searched = await runStep(quickJob("researching", {}));
  assert.equal(searched.state, "researching");
  assert.equal(searched.pending, true, "the search step waits for the next step to check the pages");
  assert.equal((searched.data?.quick as any).search.points.length, 3);
  ok("quick research: the first step searches and keeps the facts with their pages");

  const captioned = await runStep(
    quickJob("captioning", {
      analysis: "Mock analysis",
      imagePrompt: "a cup",
      verdict: { pass: true, issues: [] },
      quick: { cited: [{ url: "https://example.com/mock-1", title: "Mock source 1" }] },
    }),
  );
  const commentBody = (captioned.data?.plan as any).commentBody as string;
  assert.ok(commentBody.includes("Sources, checked before posting:") && commentBody.includes("https://example.com/mock-1"), commentBody);
  assert.equal(captioned.state, "awaiting_review");
  ok("quick research: the checked sources are added to the pinned comment that you approve");

  // ---------- carousel pictures: square, no logo, rules in every request ----------
  const carouselMod = await import("@/lib/jobs/carousel");
  const imagesMod = await import("@/lib/images");
  const sharpLib = (await import("sharp")).default;
  const oneSlide = { role: "point" as const, headline: "Sleep", body: "", imagePrompt: "a cup of tea" };
  for (const text of [
    carouselMod.slidePrompt("Flat style", oneSlide, { index: 1, total: 3 }),
    carouselMod.slidePrompt("Flat style", oneSlide, { index: 1, total: 3 }, ["the picture is landscape"]),
  ]) {
    assert.match(text, /exactly 1:1/, "every request states the square format");
    assert.match(text, /NO LOGO/, "every request forbids logos and marks");
    assert.match(text, /Never landscape or portrait/);
  }
  ok("every slide request carries the square format and the no-logo rule, including fixes");

  const huge = carouselMod.slidePrompt(
    "Style words ".repeat(200),
    { role: "hook", headline: "H".repeat(400), body: "B".repeat(400), imagePrompt: "scene ".repeat(800) },
    { index: 0, total: 8 },
    ["fix ".repeat(300)],
  );
  assert.ok(huge.length <= carouselMod.IMAGE_PROMPT_LIMIT, `the prompt is ${huge.length} characters, over the limit`);
  assert.match(huge, /exactly 1:1/, "the rules survive a long prompt");
  assert.match(huge, /NO LOGO/);
  assert.match(huge, /Swipe for more/, "the hook's swipe line survives a long prompt");
  const shortOne = carouselMod.slidePrompt("", oneSlide, { index: 1, total: 3 });
  assert.ok(shortOne.length < carouselMod.IMAGE_PROMPT_LIMIT);
  ok(`a slide prompt stays within ${carouselMod.IMAGE_PROMPT_LIMIT} characters even with long text; the rules and headline are kept`);

  const wide = await sharpLib({ create: { width: 1600, height: 900, channels: 3, background: { r: 200, g: 120, b: 60 } } }).png().toBuffer();
  const tall = await sharpLib({ create: { width: 900, height: 1600, channels: 3, background: { r: 60, g: 120, b: 200 } } }).png().toBuffer();
  for (const picture of [wide, tall]) {
    const squared = await imagesMod.squareForInstagram(picture);
    const meta = await sharpLib(squared).metadata();
    assert.equal(meta.width, 1080);
    assert.equal(meta.height, 1080);
  }
  ok("landscape and portrait pictures are cropped to a 1080 by 1080 square");

  const squareFake = await startFakeMcp({
    tools: [
      {
        name: "gemini_analyze_image",
        description: "Look at a picture and check it against a prompt.",
        inputSchema: { properties: { prompt: { type: "string" }, image: { type: "string" } }, required: ["prompt", "image"] },
        handle: () => ({ text: '{"pass": true, "issues": []}' }),
      },
    ],
  });
  const squareGemini = createGemini({ url: () => squareFake.url, toolMap: () => undefined, cookie: async () => null });
  const picture = Buffer.from("fake");
  await squareGemini.verifyImage({ topic: "tea", imagePrompt: "a cup", image: picture, mimeType: "image/jpeg", attempt: 1, square: true, expectedText: "Sleep" });
  const sent = String(squareFake.calls.at(-1)!.args.prompt);
  assert.match(sent, /6\. The picture must be square/);
  assert.match(sent, /7\. The image must show this text exactly as written: "Sleep"/);
  await squareGemini.verifyImage({ topic: "tea", imagePrompt: "a cup", image: picture, mimeType: "image/jpeg", attempt: 1 });
  assert.doesNotMatch(String(squareFake.calls.at(-1)!.args.prompt), /must be square/, "single posts are not held to the square rule");
  await squareFake.close();
  ok("picture check: carousel slides must be square and show their headline; single posts get neither rule");

  const citedPlan = carouselMod.parseCarouselPlan(
    JSON.stringify({
      analysis: "a",
      styleGuide: "s",
      slides: [
        { role: "hook", headline: "Why AI makes things up?", body: "Retrieval helps[cite: 1].", imagePrompt: "a brain [1]." },
        { role: "cta", headline: "Save this", body: "", imagePrompt: "a book" },
      ],
    }),
    2,
  );
  assert.equal(citedPlan.slides[0].body, "Retrieval helps.");
  assert.equal(citedPlan.slides[0].imagePrompt, "a brain.");
  const citedPrompt = carouselMod.slidePrompt("", citedPlan.slides[0], { index: 0, total: 2 });
  assert.ok(!citedPrompt.includes("[cite") && !citedPrompt.includes("[1]"), "citation markers never reach the picture");
  assert.ok(!citedPrompt.includes("bottom-right"), "the swipe line is not placed in a corner");
  assert.match(citedPrompt, /centred near the bottom edge/);
  ok("slide text: citation markers are removed; the swipe line stays inside the safe margin");

  const blankFake = await startFakeMcp({
    tools: [
      {
        name: "gemini_generate_image",
        description: "Generate an image from a prompt.",
        inputSchema: { properties: { prompt: { type: "string" } }, required: ["prompt"] },
        handle: () => ({ text: "", isError: true }),
      },
    ],
  });
  const blankGemini = createGemini({ url: () => blankFake.url, toolMap: () => undefined, cookie: async () => null });
  await assert.rejects(() => blankGemini.generateImage("a cup", undefined), /error with no message/);
  await blankFake.close();
  ok("an image tool error with no message says so, and that it is usually temporary");

  // ---------- temporary problems wait and are tried again ----------
  const transient = await import("@/lib/jobs/transient");
  for (const msg of [
    "The operation was aborted due to timeout",
    "gemini_generate_image returned an error with no message. It is usually temporary: retry the job.",
    "gemini_generate_image returned an error: Error executing tool gemini_generate_image: ",
    "HTTP 503 from the server",
    "fetch failed",
  ]) {
    assert.equal(transient.isTransient(msg), true, `temporary: ${msg}`);
  }
  for (const msg of [
    "gemini_generate_image returned an error: Prompt is longer than 1000 characters.",
    "GEMINI_MCP_URL is not set",
    "cookies are not set. Add them in Settings.",
    "Gemini bridge rejected the request (HTTP 401). The cookies have probably expired.",
    "No analysis stored. Retry from the analysis step.",
    "Deep research did not finish within 45 minutes.",
  ]) {
    assert.equal(transient.isTransient(msg), false, `stops the job: ${msg}`);
  }
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 12].map(transient.retryMinutes), [1, 2, 4, 8, 16, 32, 60, 60]);
  assert.equal(transient.MAX_TRANSIENT_TRIES, 12);
  ok("temporary problems are retried with waits of 1 to 60 minutes; permanent ones stop the job at once");

  // ---------- image size for the MCP servers ----------
  // A large PNG (the generator returned about 9 MB) must come back as a small JPEG,
  // or the Gemini MCP rejects the request with HTTP 413.
  const { shrinkForSending, isSendable, SEND_LIMIT } = await import("@/lib/images");
  const sharp = (await import("sharp")).default;
  const side = 2048;
  const raw = Buffer.alloc(side * side * 3);
  const noise = randomBytes(raw.length);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const i = (y * side + x) * 3;
      raw[i] = (x * 255) / side + (noise[i] & 7);
      raw[i + 1] = (y * 255) / side + (noise[i + 1] & 7);
      raw[i + 2] = ((x + y) * 127) / side + (noise[i + 2] & 7);
    }
  }
  const big = await sharp(raw, { raw: { width: side, height: side, channels: 3 } }).png().toBuffer();
  assert.ok(big.length > SEND_LIMIT, "the test image is larger than the send limit");
  assert.equal(isSendable(big, "image/png"), false, "a large PNG is not sendable as it is");
  const small = await shrinkForSending(big);
  assert.equal(small.contentType, "image/jpeg");
  assert.ok(small.bytes[0] === 0xff && small.bytes[1] === 0xd8, "the output is a JPEG");
  assert.ok(small.bytes.length <= SEND_LIMIT, "the output fits the send limit");
  assert.ok(Math.max(small.width, small.height) <= 1080, "the output is at most 1080 px on its longest side");
  assert.equal(isSendable(small.bytes, small.contentType), true);
  ok(`large PNG (${(big.length / 1024).toFixed(0)} KB) shrinks to ${(small.bytes.length / 1024).toFixed(0)} KB JPEG, ${small.width}x${small.height}`);

  console.log(`\nALL ${passed} SELF-TESTS PASSED`);
}

main().catch((err) => {
  console.error("SELF-TEST FAILED:", err);
  process.exit(1);
});
