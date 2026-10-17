export type Plan = {
  caption: string; // short hook + hashtags, shown in the feed
  commentBody: string; // detailed description, posted then pinned as the first comment
  imagePrompt: string; // prompt for image generation
};

export type Verdict = { pass: boolean; issues: string[]; revisedPrompt?: string };

export type ResearchPoll = {
  status: "running" | "done" | "failed";
  progress?: string;
  report?: string;
  error?: string;
};

export type Health = { ok: boolean; message: string; details?: Record<string, unknown> };

export type ToolSummary = { name: string; args: string[]; required: string[] };

/** How a provider is reached: an MCP server URL, an HTTP bridge, or not configured. */
export type Transport = "mcp" | "bridge" | "none";

export type Providers = {
  mode: "mock" | "live";
  gemini: {
    health(): Promise<Health>;
    startResearch(topic: string): Promise<{ ref: string }>;
    pollResearch(ref: string): Promise<ResearchPoll>;
    plan(args: { topic: string; report: string }): Promise<Plan>;
    verifyImage(args: {
      topic: string;
      plan: Plan;
      image: Buffer;
      mimeType: string;
      attempt: number;
    }): Promise<Verdict>;
    generateImage(prompt: string): Promise<{ bytes: Buffer; mimeType: string }>;
  };
  chatgpt: {
    health(): Promise<Health>;
    generateImage(prompt: string): Promise<{ bytes: Buffer; mimeType: string }>;
  };
  instagram: {
    listTools(): Promise<ToolSummary[]>;
    postPhoto(args: { imageUrl: string; caption: string }): Promise<{ mediaId: string; raw: string }>;
    comment(args: { mediaId: string; text: string }): Promise<{ commentId: string; raw: string }>;
    pin(args: { commentId: string; mediaId: string }): Promise<{ raw: string }>;
  };
};
