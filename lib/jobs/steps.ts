// The pipeline. Each call performs exactly one step and returns the next state.
// Order: research → analysis (a separate Gemini chat) → image → image check →
// caption, hashtags and pinned comment → approval. With auto-post on and a passed
// check, the post goes out right after the caption step.
import { providers } from "@/lib/adapters";
import type { Plan } from "@/lib/adapters/types";
import { draftPath, readDraft, reportPath, saveDraft } from "@/lib/blob";
import { REPORT_FILE } from "@/lib/adapters/prompts";
import { isSendable, shrinkForSending } from "@/lib/images";
import { publicMediaUrl } from "@/lib/media";
import { loadModels } from "@/lib/settings";
import { MAX_GENERATIONS, type JobRow, type State } from "./states";

const kb = (bytes: number) => (bytes / 1024).toFixed(0);

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
  const models = await loadModels(); // read per step, so a change in Settings applies to the next step

  switch (job.state) {
    case "queued":
      return { state: "researching", note: `Started (mode: ${p.mode})` };

    case "researching": {
      if (!d.researchRef) {
        const { ref } = await p.gemini.startResearch(job.topic, models.research);
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
      // The report is kept as a Markdown file: it can be downloaded, and the analysis sends this file.
      const file = await saveDraft(reportPath(job.id), Buffer.from(poll.report, "utf8"), "text/markdown; charset=utf-8");
      return {
        state: "analyzing",
        data: { report: poll.report, reportPath: file },
        note: `Research complete (${poll.report.length.toLocaleString()} characters), saved as ${REPORT_FILE}`,
      };
    }

    case "analyzing": {
      if (!d.report) throw new Error("No research report stored. Retry from the research step.");
      const a = await p.gemini.analyze({ topic: job.topic, report: d.report, model: models.analysis });
      if (!a.analysis.trim() || !a.imagePrompt.trim()) {
        throw new Error("The analysis came back without an analysis or an image prompt. Retry this step.");
      }
      return {
        state: "generating",
        data: { analysis: a.analysis.trim(), imagePrompt: a.imagePrompt.trim(), report: null, nextPrompt: null },
        note: `Analysis ready from a separate Gemini chat (${a.analysis.length.toLocaleString()} characters). The report was ${
          a.reportVia === "attached"
            ? `attached as ${REPORT_FILE}`
            : "pasted into the prompt, because the Gemini server does not take file attachments yet"
        }`,
        detail: { imagePrompt: a.imagePrompt },
      };
    }

    case "generating": {
      const attempt = job.attempts + 1;
      const prompt = d.nextPrompt || d.imagePrompt;
      if (!prompt) throw new Error("No image prompt stored. Retry from the analysis step.");
      const image =
        process.env.IMAGE_PROVIDER === "chatgpt"
          ? await p.chatgpt.generateImage(prompt)
          : await p.gemini.generateImage(prompt, models.image);
      const shrunk = await shrinkForSending(image.bytes);
      const path = await saveDraft(draftPath(job.id, attempt), shrunk.bytes, shrunk.contentType);
      return {
        state: "verifying",
        attempts: attempt,
        data: { draftPath: path, lastPrompt: prompt, nextPrompt: null },
        note: `Image generated (attempt ${attempt} of ${MAX_GENERATIONS}): ${kb(image.bytes.length)} KB original, saved as ${kb(shrunk.bytes.length)} KB JPEG ${shrunk.width}×${shrunk.height}, privately`,
        detail: { prompt },
      };
    }

    case "verifying": {
      if (!d.draftPath) throw new Error("No image stored. Retry from the image step.");
      const stored = await readDraft(d.draftPath);
      // Drafts made before the resize step can be large PNGs. Shrink them now and
      // save the small copy, so the check and the post both use the same file.
      let image = stored;
      let prefix = "";
      if (!isSendable(stored.bytes, stored.contentType)) {
        const shrunk = await shrinkForSending(stored.bytes);
        await saveDraft(d.draftPath, shrunk.bytes, shrunk.contentType);
        image = { bytes: shrunk.bytes, contentType: shrunk.contentType };
        prefix = `Image resized from ${kb(stored.bytes.length)} KB to ${kb(shrunk.bytes.length)} KB before the check. `;
      }
      const verdict = await p.gemini.verifyImage({
        topic: job.topic,
        imagePrompt: d.lastPrompt ?? d.imagePrompt ?? "",
        image: image.bytes,
        mimeType: image.contentType,
        attempt: job.attempts,
        model: models.verify,
      });
      const issues = verdict.issues.length ? verdict.issues.join("; ") : "no issues listed";

      if (verdict.pass) {
        return { state: "captioning", data: { verdict }, note: `${prefix}Image check passed.`, detail: verdict };
      }
      if (job.attempts < MAX_GENERATIONS) {
        const nextPrompt = verdict.revisedPrompt ?? `${d.imagePrompt ?? ""}\n\nFix these problems: ${issues}`;
        return {
          state: "generating",
          data: { verdict, nextPrompt },
          note: `${prefix}Image check failed (${issues}). Running the one allowed correction.`,
          detail: verdict,
        };
      }
      return {
        state: "captioning",
        data: { verdict },
        note: `${prefix}Image check failed again after ${job.attempts} attempts (${issues}). You decide at approval.`,
        detail: verdict,
      };
    }

    case "captioning": {
      if (!d.analysis) throw new Error("No analysis stored. Retry from the analysis step.");
      const c = await p.gemini.caption({ topic: job.topic, analysis: d.analysis, model: models.caption });
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
