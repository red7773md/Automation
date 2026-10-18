// Pure constants and types. Imported by both server and browser code.
import type { Plan, Verdict } from "@/lib/adapters/types";
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
  researching: "Deep research (Gemini)",
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

export type PublishProgress = { mediaId?: string; commentId?: string; pinned?: boolean; dryRun?: boolean };

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
