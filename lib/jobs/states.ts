// Pure constants and types. Imported by both server and browser code.
import type { Plan, Verdict } from "@/lib/adapters/types";

export const STATES = [
  "queued",
  "researching",
  "planning",
  "generating",
  "verifying",
  "awaiting_review",
  "publishing",
  "done",
  "failed",
] as const;
export type State = (typeof STATES)[number];

export const STATE_LABEL: Record<State, string> = {
  queued: "Queued",
  researching: "Deep research (Gemini)",
  planning: "Plan & caption (Gemini)",
  generating: "Image generation (ChatGPT)",
  verifying: "Verification (Gemini)",
  awaiting_review: "Waiting for your review",
  publishing: "Publishing (Instagram)",
  done: "Posted",
  failed: "Failed",
};

/** Steps the runner can advance without a human. */
export const RUNNABLE: readonly State[] = ["queued", "researching", "planning", "generating", "verifying", "publishing"];

/** Timeline order shown in the UI. */
export const TIMELINE: readonly State[] = [
  "queued",
  "researching",
  "planning",
  "generating",
  "verifying",
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
  plan?: Plan;
  nextPrompt?: string | null;
  lastPrompt?: string;
  draftPath?: string;
  verdict?: Verdict | null;
  reviewFeedback?: string;
  approvedAt?: string;
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
  created_at: string;
  updated_at: string;
};
