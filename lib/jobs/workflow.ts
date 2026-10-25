// Per-job workflow switches and the content typed in by hand. This file has no database
// code, so the browser can import the labels as well.
//
// Your pictures are not generated: you make them by hand (for example in ChatGPT) and upload them on the
// job page. So the switches are only the steps that can be skipped, and the picture step is always yours.

import type { JobFormat } from "./states";

export const WORKFLOW_KEYS = ["skipResearch", "skipAnalysis", "skipCaption"] as const;
export type WorkflowKey = (typeof WORKFLOW_KEYS)[number];
export type Workflow = Record<WorkflowKey, boolean>;

export const WORKFLOW_LABEL: Record<WorkflowKey, string> = {
  skipResearch: "Research (paste the report yourself)",
  skipAnalysis: "Analysis (write the image prompts yourself)",
  skipCaption: "Caption and pinned comment (write them yourself)",
};

export const WORKFLOW_HINT: Record<WorkflowKey, string> = {
  skipResearch: "The job starts at the analysis with the report you paste in.",
  skipAnalysis: "No separate Gemini chat. You give the image prompt (one per slide for a carousel), and optionally the analysis text.",
  skipCaption: "No caption request. You give the caption and the pinned comment text.",
};

export const MANUAL_LIMITS = {
  report: 100_000,
  analysis: 4_000,
  imagePrompt: 2_000,
  caption: 2_200,
  commentBody: 2_200,
  slides: 6_000, // a carousel written by hand: one image prompt per line
} as const;
export type ManualKey = keyof typeof MANUAL_LIMITS;
export type ManualInputs = Partial<Record<ManualKey, string>>;

export function defaultWorkflow(): Workflow {
  return Object.fromEntries(WORKFLOW_KEYS.map((k) => [k, false])) as Workflow;
}

/** Unknown keys are ignored. A value that is not a yes/no is refused, so a typo cannot skip a step by accident. */
export function normalizeWorkflow(input: unknown): Workflow {
  const out = defaultWorkflow();
  if (input === undefined || input === null) return out;
  if (typeof input !== "object") throw new Error("The workflow must be an object of yes or no switches");
  for (const key of WORKFLOW_KEYS) {
    const raw = (input as Record<string, unknown>)[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "boolean") throw new Error(`${key} must be true or false`);
    out[key] = raw;
  }
  return out;
}

export function normalizeManual(input: unknown): ManualInputs {
  const out: ManualInputs = {};
  if (!input || typeof input !== "object") return out;
  for (const key of Object.keys(MANUAL_LIMITS) as ManualKey[]) {
    const raw = (input as Record<string, unknown>)[key];
    if (typeof raw !== "string") continue;
    const text = raw.trim();
    if (!text) continue;
    if (text.length > MANUAL_LIMITS[key]) throw new Error(`${key} is longer than ${MANUAL_LIMITS[key]} characters`);
    out[key] = text;
  }
  return out;
}

/** The text a switch needs. Returns the first problem, or null when the job can run. */
export function missingManual(workflow: Workflow, manual: ManualInputs, format: JobFormat = "post"): string | null {
  if (workflow.skipResearch && !manual.report) return "Paste the research report, or choose a different step to skip.";
  if (workflow.skipAnalysis && format === "carousel" && !manual.slides) {
    return "Write one image prompt per line for the slides, or choose a different step to skip.";
  }
  if (workflow.skipAnalysis && format !== "carousel" && !manual.imagePrompt) {
    return "Write the image prompt, or choose a different step to skip.";
  }
  if (workflow.skipCaption && (!manual.caption || !manual.commentBody)) {
    return "Write the caption and the pinned comment text, or choose a different step to skip.";
  }
  return null;
}

/** Names of the switches that are on, for the job log and the timeline. */
export function activeSkips(workflow: Workflow): WorkflowKey[] {
  return WORKFLOW_KEYS.filter((k) => workflow[k]);
}
