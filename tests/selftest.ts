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

  const tagged = normalizePlan({ caption: "Hook line.\n\n#one #two #three #four #five #six #seven", commentBody: "b", imagePrompt: "c" });
  assert.equal(tagged.caption, "Hook line.\n\n👇 Full details in the pinned comment\n\n#one #two #three #four #five");
  const hookOnly = normalizePlan({ caption: "Only a hook", commentBody: "b", imagePrompt: "c" });
  assert.equal(hookOnly.caption, "Only a hook\n\n👇 Full details in the pinned comment");
  const { CAPTION_PROMPT } = await import("@/lib/adapters/prompts");
  assert.ok(CAPTION_PROMPT.includes("3 to 5 hashtags") && !CAPTION_PROMPT.includes("8 to 12"), "caption prompt asks for 3 to 5 hashtags");
  ok("hashtags: at most five, kept on the last line, pointer above them; caption prompt asks for 3 to 5");

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
  assert.ok(analysed.imagePrompt.startsWith("Scene: a cup of coffee\nFORMAT:"), "a plain-text picture is kept as the scene, with the rules added");
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
  // The tick's query repeats the same list as text. A job left out of it would be picked on every tick and block the others.
  const tickSource = (await import("node:fs")).readFileSync("lib/jobs/tick.ts", "utf8");
  const sqlSkips = [...tickSource.matchAll(/state not in \(([^)]*)\)/g)][0]?.[1] ?? "";
  assert.deepEqual(sqlSkips.split(",").map((s) => s.trim().replace(/'/g, "")).sort(), notRunnable, "the tick query skips the same states");
  assert.ok(notRunnable.includes("generating"), "a job waiting for its pictures is never picked by the tick");
  ok("cron tick: skips exactly the states the runner will not run, including a job waiting for its pictures");

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

    // The picture comes back as parts; the prompt is built from them, with the picture rules for a square picture.
    const pictureFake = await startFakeMcp({
      tools: [
        {
          name: "gemini_ask",
          description: "Ask Gemini a question.",
          inputSchema: { properties: { prompt: { type: "string" } }, required: ["prompt"] },
          handle: () => ({
            text: JSON.stringify({
              analysis: "Coffee angle",
              picture: { subject: "a cup", scene: "a desk by a window", composition: "centred", lighting: "soft morning light", palette: "warm browns", style: "flat illustration", mood: "calm", avoid: "faces, logos, text" },
            }),
          }),
        },
      ],
    });
    const described = await createGemini({ url: () => pictureFake.url, toolMap: () => '{"analyze":"gemini_ask"}', cookie: async () => null }).analyze({ topic: "coffee", report: "r" });
    assert.ok(described.imagePrompt.startsWith("Subject: a cup\nScene: a desk by a window\n"), described.imagePrompt);
    assert.ok(described.imagePrompt.endsWith((await import("@/lib/jobs/design")).imageRules("square")), "the picture rules close every prompt");
    assert.equal(described.parts?.subject, "a cup", "the parts are kept for the job page");
    await pictureFake.close();
    ok("single post prompt: the picture comes as parts, and the prompt is built from them with the square rules");
  } finally {
    await fileServer.close();
    await pasteServer.close();
  }

  // ---------- workflow switches and typed-in content ----------
  const { normalizeWorkflow, normalizeManual, missingManual, defaultWorkflow } = await import("@/lib/jobs/workflow");
  const { runStep } = await import("@/lib/jobs/steps");
  assert.deepEqual(normalizeWorkflow(undefined), defaultWorkflow(), "no switches means every step runs");
  assert.equal(normalizeWorkflow({ skipCaption: true, nonsense: 1 }).skipCaption, true, "unknown keys are ignored");
  assert.throws(() => normalizeWorkflow({ skipCaption: "yes" }), /must be true or false/, "a non-boolean switch is refused");
  assert.deepEqual(
    normalizeWorkflow({ skipImage: true, skipVerify: true, skipApproval: true }),
    defaultWorkflow(),
    "the switches for Gemini pictures and the picture check are gone: old saved values are ignored",
  );
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

  const legacyCheck = await runStep(jobWith("verifying", { workflow: defaultWorkflow(), draftPath: "drafts/none/1" }));
  assert.equal(legacyCheck.state, "captioning", "a job still in the old picture check goes on to the caption");
  assert.equal((legacyCheck.data?.verdict as any).skipped, true);
  ok("older jobs in the Gemini picture check: the check is no longer run, and the job goes on to the caption");

  const noAnalysis = await runStep(
    jobWith("analyzing", { workflow: { ...defaultWorkflow(), skipAnalysis: true }, report: "# Report body", manual: { imagePrompt: "a cup", analysis: "the angle" } }),
  );
  assert.equal(noAnalysis.state, "generating");
  assert.match(String(noAnalysis.data?.imagePrompt), /^Scene: a cup\nFORMAT: one square picture, exactly 1:1/, "your prompt is the picture, with the rules added");
  assert.equal((noAnalysis.data?.pictureParts as any)?.scene, "a cup");
  assert.equal(noAnalysis.data?.analysis, "the angle");
  ok("skip analysis: your image prompt and analysis text are used, with no Gemini chat");

  const waiting = await runStep(jobWith("generating", { imagePrompt: "a cup" }));
  assert.equal(waiting.state, "generating", "a job waiting for its pictures stays where it is");
  assert.equal(waiting.pending, true);
  assert.equal(waiting.quiet, true, "waiting for pictures is not logged on every poll");
  const noPicture = await runStep(
    jobWith("captioning", { workflow: { ...defaultWorkflow(), skipCaption: true }, imagePrompt: "a cup", manual: { caption: "Hook", commentBody: "Body" }, manualContinue: true }),
  );
  assert.equal(noPicture.state, "generating", "with no picture the job waits for one, and never captions or posts without it");
  assert.match(noPicture.note ?? "", /Waiting for your pictures: 1/);
  ok("your pictures: the job waits quietly for them, and does not caption or post without them");

  const skipCaption = { ...defaultWorkflow(), skipCaption: true };
  const posted = await runStep(
    jobWith("captioning", {
      workflow: skipCaption,
      imagePrompt: "a cup",
      draftPath: "drafts/x/1",
      manualContinue: true,
      manual: { caption: "Hook text #coffee", commentBody: "Full details here" },
    }),
  );
  assert.equal(posted.state, "publishing", "Continue posts at once, with your caption");
  assert.ok((posted.data?.plan as any).caption.startsWith("Hook text #coffee"));
  assert.equal((posted.data?.plan as any).commentBody, "Full details here");
  const notContinued = await runStep(
    jobWith("captioning", {
      workflow: skipCaption,
      imagePrompt: "a cup",
      draftPath: "drafts/x/1",
      manual: { caption: "Hook", commentBody: "Body" },
    }),
  );
  assert.equal(notContinued.state, "awaiting_review", "a job that was not continued (older jobs) still waits for your approval");
  ok("Continue posts the job at once with the caption; an older job without Continue waits for your approval");

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

  const handWrittenSlides = carousel.slidesFromLines("\n  a cup of coffee  \n\nsteam rising\n\n", 8, "portrait");
  assert.deepEqual(handWrittenSlides.map((s) => [s.role, s.parts?.scene]), [["hook", "a cup of coffee"], ["point", "steam rising"]]);
  const designRules = (await import("@/lib/jobs/design")).imageRules;
  assert.ok(handWrittenSlides.every((s) => s.imagePrompt.endsWith(designRules("portrait"))), "your own prompts get the picture rules too, so the shape is kept");

  // Picture prompts: built from parts, the shared look, and the picture rules last; a long prompt keeps the rules.
  const pp = await import("@/lib/jobs/picture-prompt");
  const full = { subject: "a cup", scene: "a desk", composition: "centred", lighting: "soft", palette: "brown", style: "flat", mood: "calm", avoid: "faces" };
  const squarePrompt = pp.composePicturePrompt(full, "square", "Warm flat illustration.");
  assert.ok(squarePrompt.startsWith("Subject: a cup\nScene: a desk\nComposition: centred\nLighting: soft\nColours: brown\nStyle: flat\n"), squarePrompt);
  assert.ok(squarePrompt.includes("Look shared by every picture in this set: Warm flat illustration.\nMood: calm\nAvoid: faces\n"));
  assert.ok(squarePrompt.endsWith(designRules("square")) && squarePrompt.includes("exactly 1:1"));
  assert.ok(pp.composePicturePrompt(full, "portrait").endsWith(designRules("portrait")) && pp.composePicturePrompt(full, "portrait").includes("exactly 4:5"));
  const longPrompt = pp.composePicturePrompt({ ...full, scene: "word ".repeat(2000), avoid: "x".repeat(900) }, "portrait", "style ".repeat(200));
  assert.ok(longPrompt.length <= pp.PROMPT_LIMIT, `the prompt is ${longPrompt.length} characters, over ${pp.PROMPT_LIMIT}`);
  assert.ok(longPrompt.endsWith(designRules("portrait")), "the rules are kept when the text is cut");
  assert.equal(pp.parseParts({ mood: "calm" }), null, "a picture with no subject or scene is refused");
  assert.equal(pp.parseParts("a cup"), null);
  assert.ok((pp.parseParts({ subject: "x".repeat(500) }) as any).subject.length <= pp.PART_LIMITS.subject, "each part is cut to its limit");
  assert.equal(pp.parseParts({ subject: "a cup[cite: 1]" })?.subject, "a cup", "citation markers are removed from the parts");
  ok("picture prompts: built from parts; the shared look and the shape's rules are added; long text is cut but the rules are kept");

  const structured = carousel.parseCarouselPlan(
    JSON.stringify({
      analysis: "a",
      styleGuide: "Warm flat illustration.",
      slides: [
        { role: "hook", figure: "3x", headline: "Why coffee?", body: "", picture: full },
        { role: "cta", headline: "Save this", body: "", picture: { subject: "a book", scene: "a shelf" } },
      ],
    }),
    2,
    "portrait",
  );
  assert.equal(structured.slides[0].parts?.subject, "a cup", "the parts are kept with the slide");
  assert.ok(structured.slides[0].imagePrompt.startsWith("Subject: a cup"), "the prompt is built from the parts");
  assert.ok(structured.slides[1].imagePrompt.includes("Look shared by every picture in this set: Warm flat illustration."), "every slide shares the look");
  assert.ok(structured.slides.every((s) => s.imagePrompt.endsWith(designRules("portrait"))), "every slide's prompt ends with the portrait rules");
  assert.ok(!structured.slides[0].imagePrompt.includes("Why coffee?"), "the slide's words stay out of the picture");
  assert.equal(structured.slides[0].figure, "3x");
  ok("carousel plan: each slide's picture is built from its parts, with the shared look and the shape's rules");
  assert.throws(() => carousel.slidesFromLines("only one", 8), /at least two lines/);
  assert.throws(() => carousel.slidesFromLines("a\nb\nc", 2), /3 image prompts, but this carousel has 2 slides/);
  ok("hand-written slides: one prompt per line, first line is the hook, blank lines ignored, too many refused");

  assert.equal(carousel.cut("Why coffee helps you focus every morning", 20), "Why coffee helps…", "long text is cut at a word, with an ellipsis");
  assert.equal(carousel.cleanSlideText("Coffee helps [cite: 2] , mostly [1][2]."), "Coffee helps, mostly.");
  ok("carousel text: long text is cut at a word; citation markers are removed");

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
    assert.ok(String(sent.args.prompt).includes("NO TEXT"), "the prompt forbids text before any prompt is written: the app draws it");
    assert.ok(String(sent.args.prompt).includes('"picture"') && String(sent.args.prompt).includes('"subject"'), "each picture is asked for as parts: subject, scene, and so on");
    assert.deepEqual(sent.args.attachments, [{ name: "research-report.md", content_base64: Buffer.from("# Coffee report\n\nFacts.").toString("base64") }]);
    assert.equal((await cg.analyzeCarousel({ topic: "coffee", report: "r", slideCount: 3 })).slides.length, 3);
    await cg.analyzeCarousel({ topic: "coffee", report: "r", slideCount: 3, shape: "portrait" });
    assert.ok(String(askFake.calls.at(-1)!.args.prompt).includes("exactly 4:5"), "a portrait carousel asks for 4:5 pictures");
    ok("carousel analysis: the chosen count, the shape and the report file go to Gemini; the reply is cut to that count");

    await cg.verifyImage({ topic: "coffee", imagePrompt: "a cup", image: Buffer.from("x"), mimeType: "image/png", attempt: 1, shape: "square" });
    const squareCheck = String(askFake.calls.at(-1)!.args.prompt);
    assert.match(squareCheck, /6\. The picture must be square, 1:1/, "a carousel picture must be square");
    assert.match(squareCheck, /7\. The picture must contain no text of any kind/, "a carousel picture must have no text");
    await cg.verifyImage({ topic: "coffee", imagePrompt: "a cup", image: Buffer.from("x"), mimeType: "image/png", attempt: 1, shape: "portrait" });
    assert.match(String(askFake.calls.at(-1)!.args.prompt), /6\. The picture must be portrait, 4:5/);
    await cg.verifyImage({ topic: "coffee", imagePrompt: "a cup", image: Buffer.from("x"), mimeType: "image/png", attempt: 1 });
    assert.equal(String(askFake.calls.at(-1)!.args.prompt).includes("no text of any kind"), false, "a single post is not held to the no-text rule");
    assert.equal(String(askFake.calls.at(-1)!.args.prompt).includes("{extra}"), false, "no placeholder is left in the prompt");
    ok("carousel check: a slide's picture must match its shape and have no text; single posts get neither rule");
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
  const plainDesign = { shape: "square", handle: "", footer: "Follow for more" };
  assert.deepEqual(defaultCarousel(), { slideCount: 8, ...plainDesign });
  assert.deepEqual(normalizeCarousel({}), { slideCount: 8, ...plainDesign });
  assert.deepEqual(normalizeCarousel({ slideCount: "5" }), { slideCount: 5, ...plainDesign });
  assert.deepEqual(normalizeCarousel({ slideCount: 4, shape: "portrait", handle: " rvcj.ai ", footer: "" }), { slideCount: 4, shape: "portrait", handle: "rvcj.ai", footer: "" });
  assert.throws(() => normalizeCarousel({ slideCount: 12 }), /whole number from 3 to 10/);
  assert.throws(() => normalizeCarousel({ shape: "landscape" }), /"square" or "portrait"/);
  assert.throws(() => normalizeCarousel({ handle: "x".repeat(41) }), /longer than 40 characters/);
  ok("carousel settings: missing means a post, 8 square slides and the default footer; shape, name and footer are checked");

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

  const pic = (tries: number, pass?: boolean, issues: string[] = []) => ({ attempt: 1, path: "p", tries, pass, issues });
  const wfAll = defaultWorkflow();

  // The carousel steps that need no picture storage run here. Picture generation and reading back the
  // drafts need Vercel Blob, so they are checked on the live app.
  const cPlanOf = (n: number) => ({
    analysis: "a",
    styleGuide: "s",
    slides: Array.from({ length: n }, (_, k) => ({ role: k === 0 ? ("hook" as const) : ("point" as const), headline: `h${k + 1}`, body: "", imagePrompt: `p${k + 1}` })),
  });
  const handWritten = { ...defaultWorkflow(), skipAnalysis: true };
  const planned = await runStep(
    jobWith("analyzing", { format: "carousel", slideCount: 3, workflow: handWritten, report: "# r", manual: { slides: "hook line\npoint line\nlast line" }, design: { shape: "portrait", handle: "rvcj.ai", footer: "Follow for more" } }),
  );
  assert.equal(planned.state, "generating");
  assert.equal((planned.data?.carousel as any).slides.length, 3);
  assert.equal((planned.data?.carousel as any).slides[0].role, "hook");
  assert.deepEqual(planned.data?.slideImages, [null, null, null], "every slide waits for its picture");
  assert.deepEqual(planned.data?.design, { shape: "portrait", handle: "rvcj.ai", footer: "Follow for more" }, "the look is kept with the job");
  await assert.rejects(
    () => runStep(jobWith("analyzing", { format: "carousel", slideCount: 3, workflow: handWritten, report: "# r", manual: { slides: "one" }, design: { shape: "square", handle: "", footer: "" } })),
    /at least two lines/,
  );
  ok("carousel analysis, skipped: your prompts become the slides, the first is the hook");

  const { missingPictures, checkContinue } = await import("@/lib/jobs/pictures");
  const threeSlides = { format: "carousel" as const, carousel: cPlanOf(3) };
  assert.deepEqual(missingPictures({ ...threeSlides, slideImages: [null, null, null] }), [0, 1, 2], "every slide waits for its picture at first");
  assert.deepEqual(missingPictures({ ...threeSlides, slideImages: [pic(1), null, pic(1)] }), [1]);
  assert.deepEqual(missingPictures({ ...threeSlides, slideImages: [pic(1), pic(1), pic(1)] }), []);
  assert.deepEqual(missingPictures({ ...threeSlides, slideImages: [pic(1)] }), [1, 2], "slides with no entry at all are missing too");
  assert.deepEqual(missingPictures({ format: "post" }), [0], "a single post has one picture to make");
  assert.deepEqual(missingPictures({ format: "post", draftPath: "drafts/x/0" }), []);
  ok("pictures: each slide, or the single post, has its own place; a place with no picture is missing");

  const soon = new Date("2026-10-18T00:00:00Z");
  const twoSlides = { format: "carousel" as const, carousel: cPlanOf(2), slideImages: [pic(1), pic(1)] };
  assert.deepEqual(checkContinue(twoSlides, undefined, soon), { ok: true, at: null }, "Continue with every picture posts now");
  const oneMissing = checkContinue({ ...twoSlides, slideImages: [pic(1), null] }, undefined, soon);
  assert.equal(oneMissing.ok, false, "Continue is refused while a picture is missing");
  assert.match((oneMissing as any).error, /Still missing: 2/);
  const chosen = checkContinue(twoSlides, "2026-10-18T06:30:00Z", soon);
  assert.ok(chosen.ok && chosen.at?.toISOString() === "2026-10-18T06:30:00.000Z", "a scheduled post keeps its time");
  assert.equal(checkContinue(twoSlides, "2026-10-17T23:00:00Z", soon).ok, false, "a time in the past is refused");
  assert.equal(checkContinue(twoSlides, "2026-10-18T00:00:30Z", soon).ok, false, "a time less than a minute ahead is refused");
  assert.equal(checkContinue(twoSlides, "not a time", soon).ok, false, "a time that is not a time is refused");
  ok("Continue: every picture must be uploaded; a scheduled time must be at least a minute ahead");

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
    /No picture stored for slide 2/,
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
  assert.ok(withSources("x".repeat(30000), cited).length <= 15_200, "the description stays within the total limit of its comments");
  assert.ok(withSources("x".repeat(3000), cited).includes("https://a.example/x"), "the sources survive a long description");
  ok("pinned comment: sources added at the end, and the description stays within the total limit");

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
      draftPath: "drafts/x/0",
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

  const wide = await sharpLib({ create: { width: 1600, height: 900, channels: 3, background: { r: 200, g: 120, b: 60 } } }).png().toBuffer();
  const tall = await sharpLib({ create: { width: 900, height: 1600, channels: 3, background: { r: 60, g: 120, b: 200 } } }).png().toBuffer();
  for (const picture of [wide, tall]) {
    const squared = await imagesMod.shapeForInstagram(picture, "square");
    const meta = await sharpLib(squared).metadata();
    assert.equal(meta.width, 1080);
    assert.equal(meta.height, 1080);
    const framed = await imagesMod.shapeForInstagram(picture, "portrait");
    const framedMeta = await sharpLib(framed).metadata();
    assert.equal(framedMeta.width, 1080);
    assert.equal(framedMeta.height, 1350);
  }
  assert.deepEqual(imagesMod.coverBox(1920, 1080, { width: 1080, height: 1080 }), { left: 495, top: 75, width: 930, height: 930 });
  assert.deepEqual(imagesMod.coverBox(1024, 1024, { width: 1080, height: 1350 }), { left: 159, top: 71, width: 705, height: 882 });
  ok("pictures are cut to the carousel's shape: 1080 by 1080 square or 1080 by 1350 portrait, from landscape and portrait sources");

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
  await squareGemini.verifyImage({ topic: "tea", imagePrompt: "a cup", image: picture, mimeType: "image/jpeg", attempt: 1, shape: "square" });
  const sent = String(squareFake.calls.at(-1)!.args.prompt);
  assert.match(sent, /6\. The picture must be square, 1:1/);
  assert.match(sent, /7\. The picture must contain no text of any kind/);
  await squareGemini.verifyImage({ topic: "tea", imagePrompt: "a cup", image: picture, mimeType: "image/jpeg", attempt: 1 });
  assert.doesNotMatch(String(squareFake.calls.at(-1)!.args.prompt), /must be square/, "single posts are not held to the square rule");
  await squareFake.close();
  ok("picture check: carousel slides must match their shape and have no text; single posts get neither rule");

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
  assert.equal(citedPlan.slides[0].parts?.scene, "a brain.", "a plain-text picture from an older reply is still read");
  assert.ok(!JSON.stringify(citedPlan).includes("[cite") && !citedPlan.slides[0].imagePrompt.includes("[1]"), "citation markers never reach the picture");
  ok("slide text: citation markers are removed from the slide text and the picture prompt");

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

  // ---------- carousel look: text on the picture, numbered comments, figure ----------
  const comments = await import("@/lib/jobs/comments");
  assert.deepEqual(comments.splitComment("A short description."), ["A short description."], "a short description is one comment, without a number");
  const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} explains one more point in plain words, with enough text to matter.`).join("\n\n");
  const parts = comments.splitComment(long);
  assert.ok(parts.length > 1, "a long description is split");
  assert.ok(parts.every((p, i) => p.startsWith(`${i + 1}/${parts.length}\n`)), "each part is numbered k/N in order");
  assert.ok(parts.every((p) => p.length <= comments.COMMENT_PART_LIMIT), "each part fits one comment");
  assert.ok(parts.join(" ").includes("Paragraph 60"), "nothing is lost when the text fits the parts");
  const capped = comments.splitComment("word ".repeat(20000));
  assert.equal(capped.length, comments.MAX_COMMENT_PARTS, "past the part limit the description is cut");
  assert.ok(capped.at(-1)!.endsWith("…"), "the cut is visible");
  ok("long descriptions: numbered k/N comments, each within the limit, in order; the most parts is capped");

  const designMod = await import("@/lib/jobs/design");
  assert.deepEqual(designMod.sizeOf("square"), { width: 1080, height: 1080 });
  assert.deepEqual(designMod.sizeOf("portrait"), { width: 1080, height: 1350 });
  assert.match(designMod.imageRules("portrait"), /exactly 4:5/);
  assert.throws(() => designMod.parseShape("landscape"), /"square" or "portrait"/);
  ok("carousel shapes: square is 1080 by 1080, portrait is 1080 by 1350; any other shape is refused");

  const overlay = await import("@/lib/overlay");
  const fonts = overlay.loadFonts();
  const hookText = { role: "hook" as const, figure: "3x", headline: "Why most RAG systems fail on long documents", body: "Three fixes that take one afternoon" };
  const design = { shape: "square" as const, handle: "rvcj.ai", footer: "Follow for more" };
  const svg = overlay.slideSvg({ ...hookText, design, index: 0, total: 3 }, fonts);
  assert.ok(svg.startsWith('<svg') && svg.includes('width="1080" height="1080"'), "the overlay has the square frame");
  assert.ok(!/NaN|undefined|Infinity/.test(svg), "no glyph outline has an invalid number");
  const runs = overlay.layoutText(hookText, 1080, 1080, fonts);
  assert.equal(runs[0].text, "3x", "the figure is drawn first, large");
  assert.ok(runs.every((r) => r.y < 1080 - overlay.BAR), "the text stays above the bottom bar");
  const portraitRuns = overlay.layoutText(hookText, 1080, 1350, fonts);
  assert.ok(portraitRuns.every((r) => r.x >= 72 && r.y < 1350 - overlay.BAR), "portrait text keeps its margin and stays above the bar");
  assert.ok(overlay.wrap(fonts.bold, "word ".repeat(40), 96, 936, 2).at(-1)!.endsWith("…"), "text past the last line ends in an ellipsis");
  const barOnly = overlay.barRuns({ shape: "square", handle: "@rvcj.ai", footer: "" }, 1080, 1080, fonts);
  assert.deepEqual(barOnly.map((r) => r.text), ["@rvcj.ai"], "the account name is shown with one @, and an empty footer is left out");
  ok("slide text: the figure leads, the text stays above the bar in both shapes, and a long text ends in an ellipsis");

  const figured = carouselMod.parseCarouselPlan(
    JSON.stringify({ analysis: "a", styleGuide: "s", slides: [
      { role: "hook", figure: "3x", headline: "Why it matters", body: "Brief", imagePrompt: "a lamp" },
      { role: "point", figure: "9x", headline: "Next", body: "Detail", imagePrompt: "a book" },
      { role: "cta", headline: "Save this", body: "", imagePrompt: "a flag" },
    ] }),
    3,
  );
  assert.equal(figured.slides[0].figure, "3x", "the hook keeps its figure");
  assert.equal(figured.slides[1].figure, undefined, "only the hook has a figure");
  assert.ok(!figured.slides[0].imagePrompt.includes("3x"), "the figure is drawn by the app, not in the picture");
  ok("carousel plan: the hook keeps its figure; other slides have none");

  // ---------- quick search: a reply with no web addresses says what it listed ----------
  const quickMod = await import("@/lib/jobs/quick");
  assert.throws(
    () => quickMod.parseSearchReply('{"summary": "RAG adds retrieved text to a prompt.", "points": []}'),
    /listed 0 fact\(s\), none with a web address/,
    "an empty list is reported as such, with the start of the reply",
  );
  assert.throws(
    () => quickMod.parseSearchReply('{"summary": "x", "points": [{"claim": "A fact with no address at all"}]}'),
    /listed 1 fact\(s\), none with a web address/,
  );
  const promptMod = await import("@/lib/adapters/prompts");
  assert.match(promptMod.SEARCH_PROMPT, /en\.wikipedia\.org\/wiki\//, "the search asks for a page for each fact");
  assert.doesNotMatch(promptMod.SEARCH_PROMPT, /leave that fact out/, "the search no longer drops facts for lack of an address");
  ok("quick search: a reply without addresses says how many facts it listed; the search asks for a page per fact");

  // ---------- quick search: addresses written in the forms Gemini uses ----------
  const quickParse = await import("@/lib/jobs/quick");
  const bare = quickParse.parseSearchReply('{"summary": "s", "points": [{"claim": "RAG retrieves documents before it generates text", "url": "en.wikipedia.org/wiki/Retrieval-augmented_generation", "title": "RAG"}]}');
  assert.equal(bare.points[0].url, "https://en.wikipedia.org/wiki/Retrieval-augmented_generation", "a bare domain gets https in front");
  const mdLink = quickParse.parseSearchReply('{"summary": "s", "points": [{"claim": "RAG grounds answers in retrieved text", "source": "[RAG - Wikipedia](https://en.wikipedia.org/wiki/RAG)"}]}');
  assert.equal(mdLink.points[0].url, "https://en.wikipedia.org/wiki/RAG", "an address inside a markdown link is read");
  const nested = quickParse.parseSearchReply('{"summary": "s", "points": [{"claim": "The RAG paper appeared in 2020", "citation": {"uri": "https://arxiv.org/abs/2005.11401"}}]}');
  assert.equal(nested.points[0].url, "https://arxiv.org/abs/2005.11401", "an address in a nested field is read");
  assert.throws(
    () => quickParse.parseSearchReply('{"summary": "s", "points": [{"claim": "Fact text here long enough", "url": "Wikipedia"}]}'),
    /The first fact was \{"claim":"Fact text here long enough","url":"Wikipedia"\}/,
    "the first fact is shown as Gemini wrote it",
  );
  ok("quick search: addresses as bare domains, markdown links and nested fields are read; a missing one shows the first fact");

  console.log(`\nALL ${passed} SELF-TESTS PASSED`);
}

main().catch((err) => {
  console.error("SELF-TEST FAILED:", err);
  process.exit(1);
});
