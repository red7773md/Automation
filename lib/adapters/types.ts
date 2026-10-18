export type Plan = {
  caption: string; // short hook plus hashtags, shown in the feed
  commentBody: string; // detailed description, posted then pinned as the first comment
  imagePrompt: string; // the prompt the image was made from
};

export type Analysis = {
  analysis: string; // the angle and key points, written in a new Gemini chat
  imagePrompt: string; // image prompt that suits the angle
  reportVia?: "attached" | "pasted"; // how the report reached Gemini, for the log
};

export type Caption = {
  caption: string; // short hook plus hashtags
  commentBody: string; // detailed text for the pinned comment
};

export type Verdict = { pass: boolean; issues: string[]; revisedPrompt?: string; skipped?: boolean };

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
    health(): Promise<Health>; // the server is reachable and its tools are matched
    session(): Promise<Health>; // one short question, so an expired cookie shows as a failure
    // model is optional: an empty value means the account's default model.
    startResearch(topic: string, model?: string): Promise<{ ref: string }>;
    pollResearch(ref: string): Promise<ResearchPoll>;
    analyze(args: { topic: string; report: string; model?: string }): Promise<Analysis>;
    caption(args: { topic: string; analysis: string; model?: string }): Promise<Caption>;
    verifyImage(args: {
      topic: string;
      imagePrompt: string;
      image: Buffer;
      model?: string;
      mimeType: string;
      attempt: number;
    }): Promise<Verdict>;
    generateImage(prompt: string, model?: string): Promise<{ bytes: Buffer; mimeType: string }>;
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
    status(): Promise<Health & { username?: string }>; // is the Instagram login still valid
  };
};
