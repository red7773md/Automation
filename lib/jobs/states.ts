// Pure constants and types. Imported by both server and browser code.
import type { CarouselPlan, ConfirmedPoint, PictureParts, Plan, QuickSearch, Verdict } from "@/lib/adapters/types";
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
  generating: "Your pictures (you upload them)",
  verifying: "Image check (Gemini, older jobs)",
  captioning: "Caption, hashtags and pinned comment (Gemini)",
  awaiting_review: "Waiting for your approval (older jobs)",
  publishing: "Publishing (Instagram)",
  done: "Posted",
  failed: "Failed",
};

/**
 * Steps the runner advances without a human. A job waiting for its pictures ("generating") is not one of them:
 * it waits until every picture is uploaded and you press Continue. "verifying" and "awaiting_review" only remain
 * for jobs made before the change.
 */
export const RUNNABLE: readonly State[] = ["queued", "researching", "analyzing", "verifying", "captioning", "publishing"];

/**
 * A job can be cancelled in any of these states. Not while publishing: the post may already be out.
 * Done and failed jobs have nothing left to cancel.
 */
export const CANCELLABLE: readonly State[] = [
  "queued",
  "researching",
  "analyzing",
  "generating",
  "verifying",
  "captioning",
  "awaiting_review",
];

/** Timeline order shown in the UI. */
export const TIMELINE: readonly State[] = [
  "queued",
  "researching",
  "analyzing",
  "generating",
  "captioning",
  "publishing",
  "done",
];

/** A post is one picture. A carousel is one picture per slide, posted together as one album. */
export type JobFormat = "post" | "carousel";

/** One slide's picture, as uploaded. `pass` and `issues` are only set on jobs made before the check was removed. */
export type SlideImage = {
  attempt: number; // the job attempt that made the picture; the stored path and the link use it
  path: string; // where the picture is kept in private storage
  tries: number; // how many pictures were uploaded for this slide
  pass?: boolean;
  issues?: string[];
};

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
  analysis?: string; // Gemini's analysis of the report, written in a new chat
  imagePrompt?: string; // the picture prompt (a carousel: one numbered line per slide)
  pictureParts?: PictureParts | null; // a single post's picture as parts (shown on the job page)
  plan?: Plan; // caption with hashtags, pinned-comment text and the image prompt
  nextPrompt?: string | null; // older jobs only
  lastPrompt?: string;
  draftPath?: string; // a single post: its uploaded picture
  verdict?: Verdict | null; // older jobs only: the picture check
  reviewFeedback?: string;
  approvedAt?: string;
  manualContinue?: boolean; // Continue was pressed: the caption is written and the post goes out, at the time chosen if any
  continuedAt?: string;
  cancelled?: boolean; // stopped by you: the job is failed, and Retry resumes it from failedStep
  cancelledAt?: string;
  failedStep?: State;
  publish?: PublishProgress;
  publishedAt?: string;
  format?: JobFormat; // a missing format means a single post
  slideCount?: number; // carousel: the number of slides chosen for this job
  design?: SlideDesign; // carousel: picture shape, account name and footer, as they were when the job was created
  carousel?: CarouselPlan; // carousel: the analysis, the shared style and the slides in swipe order
  slideImages?: (SlideImage | null)[]; // carousel: one entry per slide, null until its picture is uploaded
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
