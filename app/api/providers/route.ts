import { providers, transports } from "@/lib/adapters";
import { adminRoute, json } from "@/lib/api";
import { cookieMeta } from "@/lib/secrets";

export const GET = adminRoute(async () => {
  const [gemini, chatgpt] = await Promise.all([cookieMeta("gemini"), cookieMeta("chatgpt")]);
  return json({
    mode: providers().mode,
    imageProvider: process.env.IMAGE_PROVIDER === "chatgpt" ? "chatgpt" : "gemini",
    transports: transports(),
    gemini,
    chatgpt,
    instagram: { configured: !!process.env.INSTAGRAM_MCP_URL },
    publicUrl: !!(process.env.PUBLIC_APP_URL || process.env.VERCEL_URL),
  });
});
