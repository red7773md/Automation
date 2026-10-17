// The pipeline. Each call performs exactly one step and returns the next state.
// Order: research → analysis (a separate Gemini chat) → image → image check →
// caption, hashtags and pinned comment → approval. With auto-post on and a passed
// check, the post goes out right after the caption step.
import { providers } from "@/lib/adapters";
import type { Plan } from "@/lib/adapters/types";
import { draftPath, readDraft, saveDraft } from "@/lib/blob";
import { publicMediaUrl } from "@/lib/media";
import { MAX_GENERATIONS, type JobRow, type State } from "./states";

export type StepResult = {
  state: State;
  data?: Record<string, unknown>;
  attempts?: number;
  note?: string;
  detail?: unknown;
  pending?: boolean; // external work still running; poll again later
};

const RESEARCH_TIMEOUT_MIN = 45; // deep research normally takes 5 to 10 minutes
const MAX_TEXT = 2200; // Instagram caption and comment limit
const POINTER = "👇 Full details in the pinned comment";

export function normalizePlan(p: Partial<Plan>): Plan {
  const missing = (["caption", "commentBody", "imagePrompt"] as const).filter((k) => !p[k]?.trim());
  if (missing.length) throw new Error(`The caption step returned an incomplete result, missing: ${missing.join(", ")}`);

  let caption = p.caption!.trim();
  const room = MAX_TEXT - POINTER.length - 2;
  if (caption.length > room) caption = caption.slice(0, room);
  if (!/pinned comment/i.test(caption)) caption = `${caption}\n\n${POINTER}`;

  return {
    caption,
    commentBody: p.commentBody!.trim().slice(0, MAX_TEXT),
    imagePrompt: p.imagePrompt!.trim(),
  };
}

export async function runStep(job: JobRow): Promise<StepResult> {
  const p = providers();
  const d = job.data;

  switch (job.state) {
    case "queued":
      return { state: "researching", note: `Started (mode: ${p.mode})` };

    case "researching": {
      if (!d.researchRef) {
        const { ref } = await p.gemini.startResearch(job.topic);
        return {
          state: "researching",
          data: { researchRef: ref, researchStartedAt: new Date().toISOString() },
          pending: true,
          note: "Deep research started on Gemini",
        };
      }
      const poll = await p.gemini.pollResearch(d.researchRef);
      if (poll.status === "running") {
        const elapsedMin = (Date.now() - new Date(d.researchStartedAt ?? Date.now()).getTime()) / 60_000;
        if (elapsedMin > RESEARCH_TIMEOUT_MIN) {
          throw new Error(`Deep research did not finish within ${RESEARCH_TIMEOUT_MIN} minutes. Retry the job or simplify the topic.`);
        }
        return {
          state: "researching",
          pending: true,
          note: `Deep research still running${poll.progress ? `: ${poll.progress}` : ""}`,
        };
      }
      if (poll.status === "failed" || !poll.report) {
        throw new Error(`Deep research failed: ${poll.error ?? "no report returned"}`);
      }
      return {
        state: "analyzing",
        data: { report: poll.report },
        note: `Research complete (${poll.report.length.toLocaleString()} characters)`,
      };
    }

    case "analyzing": {
      if (!d.report) throw new Error("No research report stored. Retry from the research step.");
      const a = await p.gemini.analyze({ topic: job.topic, report: d.report });
      if (!a.analysis.trim() || !a.imagePrompt.trim()) {
        throw new Error("The analysis came back without an analysis or an image prompt. Retry this step.");
      }
      return {
        state: "generating",
        data: { analysis: a.analysis.trim(), imagePrompt: a.imagePrompt.trim(), report: null, nextPrompt: null },
        note: `Analysis ready from a separate Gemini chat (${a.analysis.length.toLocaleString()} characters)`,
        detail: { imagePrompt: a.imagePrompt },
      };
    }

    case "generating": {
      const attempt = job.attempts + 1;
      const prompt = d.nextPrompt || d.imagePrompt;
      if (!prompt) throw new Error("No image prompt stored. Retry from the analysis step.");
      const source = process.env.IMAGE_PROVIDER === "chatgpt" ? p.chatgpt : p.gemini;
      const image = await source.generateImage(prompt);
      const path = await saveDraft(draftPath(job.id, attempt), image.bytes, image.mimeType);
      return {
        state: "verifying",
        attempts: attempt,
        data: { draftPath: path, lastPrompt: prompt, nextPrompt: null },
        note: `Image generated (attempt ${attempt} of ${MAX_GENERATIONS}, ${(image.bytes.length / 1024).toFixed(0)} KB), saved privately`,
        detail: { prompt },
      };
    }

    case "verifying": {
      if (!d.draftPath) throw new Error("No image stored. Retry from the image step.");
      const draft = await readDraft(d.draftPath);
      const verdict = await p.gemini.verifyImage({
        topic: job.topic,
        imagePrompt: d.lastPrompt ?? d.imagePrompt ?? "",
        image: draft.bytes,
        mimeType: draft.contentType,
        attempt: job.attempts,
      });
      const issues = verdict.issues.length ? verdict.issues.join("; ") : "no issues listed";

      if (verdict.pass) {
        return { state: "captioning", data: { verdict }, note: "Image check passed.", detail: verdict };
      }
      if (job.attempts < MAX_GENERATIONS) {
        const nextPrompt = verdict.revisedPrompt ?? `${d.imagePrompt ?? ""}\n\nFix these problems: ${issues}`;
        return {
          state: "generating",
          data: { verdict, nextPrompt },
          note: `Image check failed (${issues}). Running the one allowed correction.`,
          detail: verdict,
        };
      }
      return {
        state: "captioning",
        data: { verdict },
        note: `Image check failed again after ${job.attempts} attempts (${issues}). You decide at approval.`,
        detail: verdict,
      };
    }

    case "captioning": {
      if (!d.analysis) throw new Error("No analysis stored. Retry from the analysis step.");
      const c = await p.gemini.caption({ topic: job.topic, analysis: d.analysis });
      const plan = normalizePlan({ ...c, imagePrompt: d.imagePrompt });
      const post = d.autoPost === true && d.verdict?.pass === true;
      return {
        state: post ? "publishing" : "awaiting_review",
        data: { plan },
        note: `Caption ready (${plan.caption.length} characters with hashtags), pinned comment ${plan.commentBody.length} characters. ${
          post ? "Auto-post is on, so posting now." : "Waiting for your approval."
        }`,
      };
    }

    case "publishing": {
      const plan = d.plan!;
      const dryRun = p.mode === "mock";
      const tag = dryRun ? "DRY RUN: " : "";
      const pub = { ...(d.publish ?? {}) };

      // Each sub-step is saved before the next one runs, so a retry never posts the photo twice.
      if (!pub.mediaId) {
        const imageUrl = dryRun ? "mock://draft" : publicMediaUrl(job.id, job.attempts);
        const post = await p.instagram.postPhoto({ imageUrl, caption: plan.caption });
        return {
          state: "publishing",
          data: { publish: { ...pub, mediaId: post.mediaId, dryRun } },
          note: `${tag}photo posted (media ${post.mediaId})`,
          detail: post.raw,
        };
      }
      if (!pub.commentId) {
        const c = await p.instagram.comment({ mediaId: pub.mediaId, text: plan.commentBody });
        return {
          state: "publishing",
          data: { publish: { ...pub, commentId: c.commentId } },
          note: `${tag}detail comment posted (${c.commentId})`,
          detail: c.raw,
        };
      }
      if (!pub.pinned) {
        await p.instagram.pin({ commentId: pub.commentId, mediaId: pub.mediaId });
        return {
          state: "publishing",
          data: { publish: { ...pub, pinned: true } },
          note: `${tag}detail comment pinned`,
        };
      }
      return {
        state: "done",
        data: { publishedAt: new Date().toISOString() },
        note: `${tag}post complete`,
      };
    }

    default:
      throw new Error(`No step is defined for state "${job.state}"`);
  }
}
