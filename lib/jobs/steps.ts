// The pipeline. Each call performs exactly one step and returns the next state.
// Order: research → analysis (a separate Gemini chat) → image → image check →
// caption, hashtags and pinned comment → approval. A switched-off step is skipped and
// the job moves on: the text or image typed in by hand takes its place. With auto-post
// on (or Skip approval) and a passed check, the post goes out right after the caption.
import { providers } from "@/lib/adapters";
import type { Plan } from "@/lib/adapters/types";
import { REPORT_FILE } from "@/lib/adapters/prompts";
import { draftPath, readDraft, reportPath, saveDraft } from "@/lib/blob";
import { isSendable, shrinkForSending } from "@/lib/images";
import { publicMediaUrl } from "@/lib/media";
import { defaultModels, type ModelSettings } from "@/lib/settings";
import { normalizeWorkflow, type Workflow } from "./workflow";
import { MAX_GENERATIONS, type JobRow, type State } from "./states";
import { analyzeCarousel, generateSlide, verifySlide } from "./carousel-steps";

const kb = (bytes: number) => (bytes / 1024).toFixed(0);

export type StepResult = {
  state: State;
  data?: Record<string, unknown>;
  attempts?: number;
  note?: string;
  detail?: unknown;
  pending?: boolean; // external work still running, or waiting for you; poll again later
  quiet?: boolean; // a waiting step: do not write a log line on every poll
};

// Deep research usually takes 5 to 10 minutes but can run for hours. Retrying the job restarts this clock.
const RESEARCH_TIMEOUT_MIN = 180;
// Gemini sometimes says it did not connect in time. That passes, so the step tries again.
const START_TRIES = 5;
const MAX_TEXT = 2200; // Instagram caption and comment limit
const POINTER = "👇 Full details in the pinned comment";
const ANALYSIS_EXCERPT = 1500; // used as the analysis when you skip analysis and write no analysis text

/** True once deep research has been running longer than the limit. No start time: never times out. */
export function researchTimedOut(startedAt: string | undefined, now = Date.now()): boolean {
  if (!startedAt) return false;
  const started = new Date(startedAt).getTime();
  return Number.isFinite(started) && (now - started) / 60_000 > RESEARCH_TIMEOUT_MIN;
}

/** Gemini's "did not connect in time" reply. It passes on its own, so trying again is worth it. */
export function isTransientConnectError(message: string): boolean {
  return /did not connect/i.test(message) || /try again/i.test(message);
}

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

/**
 * Performs one step. `models` comes from Settings; the runner loads it, so tests can call
 * this without a database. The job's own workflow switches (fixed when it was created) decide
 * which steps are skipped.
 */
export async function runStep(job: JobRow, models: ModelSettings = defaultModels()): Promise<StepResult> {
  const p = providers();
  const d = job.data;
  const wf: Workflow = normalizeWorkflow(d.workflow);
  const manual = d.manual ?? {};

  // A carousel has its own analysis, pictures and check. Research and the caption are shared with a single post.
  if ((d.format ?? "post") === "carousel") {
    if (job.state === "analyzing") return analyzeCarousel(job, wf, models);
    if (job.state === "generating") return generateSlide(job, models);
    if (job.state === "verifying") return verifySlide(job, wf, models);
  }

  switch (job.state) {
    case "queued": {
      if (wf.skipResearch) {
        const text = manual.report ?? "";
        if (!text) throw new Error("No report was pasted. Add it on the job page, or turn off Skip deep research.");
        const file = await saveDraft(reportPath(job.id), Buffer.from(text, "utf8"), "text/markdown; charset=utf-8");
        return {
          state: "analyzing",
          data: { report: text, reportPath: file },
          note: `Report supplied by you (${text.length.toLocaleString()} characters), saved as ${REPORT_FILE}. Research skipped.`,
        };
      }
      return { state: "researching", note: `Started (mode: ${p.mode})` };
    }

    case "researching": {
      if (!d.researchRef) {
        let started: { ref: string };
        try {
          started = await p.gemini.startResearch(job.topic, models.research);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!isTransientConnectError(message)) throw err;
          const tries = (d.startTries ?? 0) + 1;
          if (tries >= START_TRIES) {
            throw new Error(`Gemini did not connect after ${START_TRIES} tries. Check the Gemini server's cookies, then retry the job. Last reply: ${message}`);
          }
          return {
            state: "researching",
            data: { startTries: tries },
            pending: true,
            note: `Gemini did not connect (try ${tries} of ${START_TRIES}). Trying again.`,
          };
        }
        return {
          state: "researching",
          data: { researchRef: started.ref, researchStartedAt: new Date().toISOString() },
          pending: true,
          note: "Deep research started on Gemini",
        };
      }
      const poll = await p.gemini.pollResearch(d.researchRef);
      if (poll.status === "running") {
        if (researchTimedOut(d.researchStartedAt)) {
          throw new Error(
            `Deep research did not finish within ${RESEARCH_TIMEOUT_MIN} minutes. Gemini still reported it as running. Retry the job to check again, or simplify the topic.`,
          );
        }
        return {
          state: "researching",
          pending: true,
          note: `Deep research still running${poll.progress ? `: ${poll.progress}` : ""}`,
          // Gemini's own reply, so a stuck job shows what it said.
          detail: poll.raw ? { geminiReply: poll.raw } : undefined,
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
      if (wf.skipAnalysis) {
        const imagePrompt = (manual.imagePrompt ?? "").trim();
        if (!imagePrompt) throw new Error("No image prompt was written. Add it on the job page, or turn off Skip analysis.");
        const analysis = (manual.analysis ?? d.report.slice(0, ANALYSIS_EXCERPT)).trim();
        return {
          state: "generating",
          data: { analysis, imagePrompt, report: null, nextPrompt: null },
          note: `Analysis skipped. Your image prompt is used, with ${manual.analysis ? "your analysis text" : "the start of the report as the analysis"}.`,
        };
      }
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
      if (wf.skipImage) {
        // Nothing to generate: wait until an image is uploaded on the job page. Each poll is quiet.
        if (!d.uploadedDraftPath) {
          return { state: "generating", pending: true, quiet: true, note: "Waiting for your image upload" };
        }
        const attempt = job.attempts + 1;
        return {
          state: "verifying",
          attempts: attempt,
          data: { draftPath: d.uploadedDraftPath, uploadedDraftPath: null, lastPrompt: "uploaded by you", nextPrompt: null },
          note: `Image uploaded by you (attempt ${attempt}), used as the draft`,
        };
      }
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
      if (wf.skipVerify) {
        return {
          state: "captioning",
          data: { verdict: { pass: true, issues: [], skipped: true } },
          note: "Image check skipped (your setting).",
        };
      }
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
      let plan: Plan;
      if (wf.skipCaption) {
        plan = normalizePlan({ caption: manual.caption, commentBody: manual.commentBody, imagePrompt: d.imagePrompt ?? "" });
      } else {
        if (!d.analysis) throw new Error("No analysis stored. Retry from the analysis step.");
        const c = await p.gemini.caption({ topic: job.topic, analysis: d.analysis, model: models.caption });
        plan = normalizePlan({ ...c, imagePrompt: d.imagePrompt });
      }
      // A failed check twice still stops for you, even with approval skipped.
      const post = (wf.skipApproval || d.autoPost === true) && d.verdict?.pass === true;
      return {
        state: post ? "publishing" : "awaiting_review",
        data: { plan },
        note: `${wf.skipCaption ? "Caption written by you" : "Caption ready"} (${plan.caption.length} characters with hashtags), pinned comment ${plan.commentBody.length} characters. ${
          post ? "Posting now without your approval." : "Waiting for your approval."
        }`,
      };
    }

    case "publishing": {
      const plan = d.plan!;
      const dryRun = p.mode === "mock";
      const tag = dryRun ? "DRY RUN: " : "";
      const pub = { ...(d.publish ?? {}) };

      // Each sub-step is saved before the next one runs, so a retry never posts the photo twice.
      if (!pub.mediaId && (d.format ?? "post") === "carousel") {
        // One album post with the slides in order. Each picture has its own signed link for its slide.
        const slides = d.slideImages ?? [];
        const planned = d.carousel?.slides.length ?? 0;
        if (!planned || slides.length !== planned) {
          throw new Error(`The carousel has ${slides.length} of ${planned} pictures. Retry from the image step.`);
        }
        const imageUrls = slides.map((img, i) => (dryRun ? "mock://draft" : publicMediaUrl(job.id, img.attempt, i)));
        const album = await p.instagram.postAlbum({ imageUrls, caption: plan.caption });
        return {
          state: "publishing",
          data: { publish: { ...pub, mediaId: album.mediaId, dryRun } },
          note: `${tag}carousel posted as one album of ${imageUrls.length} pictures (media ${album.mediaId})`,
          detail: album.raw,
        };
      }
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
