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

/** One slide of a carousel: where it sits in the swipe order, the text the picture shows, and the prompt that makes the picture. */
export type Slide = {
  role: "hook" | "point" | "cta"; // hook is the first slide, cta the last
  headline: string; // large text on the picture; empty when the slide was written by hand
  body: string; // a smaller line under the headline
  imagePrompt: string;
};

/** What a carousel analysis returns: the angle, the look shared by every slide, and the slides in swipe order. */
export type CarouselPlan = {
  analysis: string;
  styleGuide: string;
  slides: Slide[];
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

/** A model the account can use. `available` is false for a model this account cannot use (for example an Advanced one). */
export type AccountModel = { name: string; displayName: string; available: boolean };
/** The account's models as the Gemini server last saw them. `message` says why there are none. */
export type AccountModels = { models: AccountModel[]; verifiedAt: string | null; message?: string };

/** One fact from a quick web search, with the page it came from. */
export type SearchPoint = { claim: string; url: string; title: string };
export type QuickSearch = { summary: string; points: SearchPoint[] };
/** A fact after it was checked against the text of its page. */
export type ConfirmedPoint = SearchPoint & { supported: boolean; reason?: string };

export type Providers = {
  mode: "mock" | "live";
  gemini: {
    health(): Promise<Health>; // the server is reachable and its tools are matched
    session(): Promise<Health>; // one short question, so an expired cookie shows as a failure
    models(): Promise<AccountModels>; // the models this account can use, from the Gemini server's last cookie check
    // model is optional: an empty value means the account's default model.
    startResearch(topic: string, model?: string): Promise<{ ref: string }>;
    pollResearch(ref: string): Promise<ResearchPoll>;
    analyze(args: { topic: string; report: string; model?: string }): Promise<Analysis>;
    analyzeCarousel(args: { topic: string; report: string; slideCount: number; model?: string }): Promise<CarouselPlan>;
    search(args: { topic: string; model?: string }): Promise<QuickSearch>; // quick research: facts found on the web, with their pages
    confirm(args: {
      topic: string;
      points: SearchPoint[];
      sources: { url: string; title: string; text: string }[];
      model?: string;
    }): Promise<ConfirmedPoint[]>; // each fact checked against the text of its page
    caption(args: { topic: string; analysis: string; model?: string }): Promise<Caption>;
    verifyImage(args: {
      topic: string;
      imagePrompt: string;
      image: Buffer;
      model?: string;
      mimeType: string;
      attempt: number;
      expectedText?: string; // the headline the picture must show, when the slide has one
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
    postAlbum(args: { imageUrls: string[]; caption: string }): Promise<{ mediaId: string; raw: string }>; // 2 to 10 pictures, in order
    comment(args: { mediaId: string; text: string }): Promise<{ commentId: string; raw: string }>;
    pin(args: { commentId: string; mediaId: string }): Promise<{ raw: string }>;
    status(): Promise<Health & { username?: string }>; // is the Instagram login still valid
  };
};
