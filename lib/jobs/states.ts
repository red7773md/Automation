// Pure constants and types. Imported by both server and browser code.
import type { CarouselPlan, ConfirmedPoint, Plan, QuickSearch, Verdict } from "@/lib/adapters/types";
import type { SlideDesign } from "./design";
import type { ManualInputs, Workflow } from "./workflow";

export const STATES = [
  "queued",
  "researching",
  "analyzing",
  "generating",
  "verifying",
  "captioning",
  "awaiting_review",
  "publishing",
  "done",
  "failed",
] as const;
export type State = (typeof STATES)[number];

export const STATE_LABEL: Record<State, string> = {
  queued: "Waiting to start",
  researching: "Research (Gemini)",
  analyzing: "Analysis in a new Gemini chat",
  generating: "Image (Gemini)",
  verifying: "Image check (Gemini)",
  captioning: "Caption, hashtags and pinned comment (Gemini)",
  awaiting_review: "Waiting for your approval",
  publishing: "Publishing (Instagram)",
  done: "Posted",
  failed: "Failed",
};

/** Steps the runner can advance without a human. */
export const RUNNABLE: readonly State[] = [
  "queued",
  "researching",
  "analyzing",
  "generating",
  "verifying",
  "captioning",
  "publishing",
];

/** Timeline order shown in the UI. */
export const TIMELINE: readonly State[] = [
  "queued",
  "researching",
  "analyzing",
  "generating",
  "verifying",
  "captioning",
  "awaiting_review",
  "publishing",
  "done",
];

/** One correction only: generate → verify → (fail) → generate again → verify → (fail) → human review. */
export const MAX_GENERATIONS = 2;

/** A post is one picture. A carousel is one picture per slide, posted together as one album. */
export type JobFormat = "post" | "carousel";

/** One slide's picture. `pass` stays unset until the slide has been checked. */
export type SlideImage = {
  attempt: number; // the job attempt that made the picture; the stored path and the link use it
  path: string; // where the picture is kept in private storage
  tries: number; // how many times this slide has been made
  pass?: boolean;
  issues?: string[];
};

/** What the next try of one slide should change: the problems found, and possibly a new prompt. */
export type SlideFix = { index: number; notes: string[]; imagePrompt?: string };

/** Deep research (slow, thorough) or a quick search whose facts are checked against their pages. */
export type ResearchStyle = "deep" | "quick";

/** A page the quick search cites, after it was opened. */
export type SourceRecord = { url: string; title: string; ok: boolean; error?: string };

export type QuickData = {
  search?: QuickSearch; // the facts found on the web
  sources?: SourceRecord[]; // every page that was opened, and whether it could be read
  confirmed?: ConfirmedPoint[]; // every fact, with the checker's verdict
  cited?: { url: string; title: string }[]; // the sources kept for the post, put in the pinned comment
};

export type PublishProgress = { mediaId?: string; commentId?: string; commentIds?: string[]; pinned?: boolean; dryRun?: boolean };

export type JobData = {
  researchRef?: string;
  researchStartedAt?: string;
  report?: string | null;
  reportPath?: string; // the report saved as a Markdown file in Blob storage
  workflow?: Workflow; // the switches this job was created with
  manual?: ManualInputs; // text typed in by hand for the switched-off steps
  uploadedDraftPath?: string; // an image uploaded while the job waits for one (skip image generation)
  analysis?: string; // Gemini's analysis of the report, written in a new chat
  imagePrompt?: string; // image prompt suggested by the analysis
  plan?: Plan; // caption with hashtags, pinned-comment text and the image prompt
  nextPrompt?: string | null;
  lastPrompt?: string;
  draftPath?: string;
  verdict?: Verdict | null;
  reviewFeedback?: string;
  approvedAt?: string;
  autoPost?: boolean; // post without waiting for approval when the image check passes
  failedStep?: State;
  publish?: PublishProgress;
  publishedAt?: string;
  format?: JobFormat; // a missing format means a single post
  slideCount?: number; // carousel: the number of slides chosen for this job
  design?: SlideDesign; // carousel: picture shape, account name and footer, as they were when the job was created
  carousel?: CarouselPlan; // carousel: the analysis, the shared style and the slides in swipe order
  slideImages?: SlideImage[]; // carousel: one entry per slide, in order, as far as they have been made
  slideIndex?: number; // carousel: the slide being made or checked now
  slideFix?: SlideFix | null; // carousel: what to change the next time this slide is made
  research?: ResearchStyle; // a missing style means deep research
  quick?: QuickData; // quick research: the search, the page checks and what was kept
  transientTries?: number; // temporary problems in a row for the current step; reset when a step succeeds
  retryAt?: string | null; // when the job may be tried again after a temporary problem
};

export type JobRow = {
  id: string;
  topic: string;
  state: State;
  busy: boolean;
  attempts: number;
  data: JobData;
  error: string | null;
  scheduled_at: string;
  created_at: string;
  updated_at: string;
};
