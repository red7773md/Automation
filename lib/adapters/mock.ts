// Mock mode: exercises the whole pipeline without calling any real service.
// Nothing is sent to Instagram. The verifier fails the first image, so the
// one-time correction loop runs. Images are generated gradients.
import { deflateSync } from "node:zlib";
import type { Providers } from "./types";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function makePng(size: number): Buffer {
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = y * stride + 1 + x * 3;
      raw[o] = Math.floor((x * 255) / size);
      raw[o + 1] = Math.floor((y * 255) / size);
      raw[o + 2] = 180;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export const mockProviders: Providers = {
  mode: "mock",
  gemini: {
    health: async () => ({ ok: true, message: "MOCK mode: no request was sent to Gemini" }),
    generateImage: async () => ({ bytes: makePng(512), mimeType: "image/png" }),
    startResearch: async () => ({ ref: `mock:${Date.now()}` }),
    pollResearch: async (ref) => {
      const started = Number(ref.split(":")[1]);
      if (Date.now() - started < 6_000) return { status: "running", progress: "mock source 3 of 7" };
      return { status: "done", report: "Mock research report: key facts, sources and angles for the topic." };
    },
    analyze: async ({ topic }) => ({
      analysis: `Mock analysis of ${topic}: three points that matter most, and the angle for Instagram.`,
      imagePrompt: `A clean, bright flat illustration representing ${topic}, square format, no text.`,
    }),
    caption: async ({ topic }) => ({
      caption: `Quick take on ${topic} 🧠 Save this for later.\n\n#mock #instagram #${topic.replace(/\W+/g, "").slice(0, 20)}`,
      commentBody: `Full breakdown of ${topic}:\n\n1) First key point\n2) Second key point\n3) Third key point\n\n(mock content)`,
    }),
    verifyImage: async ({ attempt }) =>
      attempt >= 2
        ? { pass: true, issues: [] }
        : {
            pass: false,
            issues: ["mock: visual artifact in the corner"],
            revisedPrompt: "A clean, bright flat illustration, square format, no text, no artifacts.",
          },
  },
  chatgpt: {
    health: async () => ({ ok: true, message: "MOCK mode: no request was sent to ChatGPT" }),
    generateImage: async () => ({ bytes: makePng(512), mimeType: "image/png" }),
  },
  instagram: {
    listTools: async () => [
      { name: "instagram_post_photo", args: ["image_url", "caption"], required: ["image_url"] },
      { name: "instagram_comment_on_post", args: ["media_id", "text"], required: ["media_id", "text"] },
      { name: "instagram_pin_comment", args: ["comment_id", "pin"], required: ["comment_id"] },
    ],
    postPhoto: async () => ({ mediaId: `mock-media-${Date.now()}`, raw: "[mock] nothing was sent to Instagram" }),
    comment: async () => ({ commentId: `mock-comment-${Date.now()}`, raw: "[mock]" }),
    pin: async () => ({ raw: "[mock]" }),
  },
};
