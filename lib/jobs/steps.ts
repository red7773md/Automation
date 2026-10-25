// The pipeline. Each call performs exactly one step and returns the next state.
// Order: research → analysis (a separate Gemini chat, which writes the picture prompts) → your pictures →
// caption, hashtags and pinned comment → post. The pictures are made by hand (for example in ChatGPT) and
// uploaded on the job page; nothing here generates them. Continue on the job page starts the caption and the
// post, now or at the time you chose. A switched-off step is skipped and the job moves on: the text typed in
// by hand takes its place.
import { providers } from "@/lib/adapters";
import type { Plan } from "@/lib/adapters/types";
import { REPORT_FILE } from "@/lib/adapters/prompts";
import { reportPath, saveDraft } from "@/lib/blob";
import { publicMediaUrl } from "@/lib/media";
import { defaultModels, type ModelSettings } from "@/lib/settings";
import { normalizeWorkflow, type Workflow } from "./workflow";
import type { JobRow, State } from "./states";
import { analyzeCarousel, composeCarousel } from "./carousel-steps";
import { quickResearch } from "./quick-steps";
import { withSources } from "./quick";
import { COMMENT_TOTAL_LIMIT, splitComment } from "./comments";
import { missingPictures } from "./pictures";
import { composePicturePrompt, partsFromText } from "./picture-prompt";

export type StepResult = {
  state: State;
  data?: Record<string, unknown>;
  attempts?: number;
  note?: string;
  detail?: unknown;
  pending?: boolean; // external work still running, or waiting for you; poll again later
  quiet?: boolean; // a waiting step: do not write a log line on every poll
};

const RESEARCH_TIMEOUT_MIN = 45; // deep research normally takes 5 to 10 minutes
const MAX_TEXT = 2200; // Instagram caption and comment limit
const POINTER = "👇 Full details in the pinned comment";
const ANALYSIS_EXCERPT = 1500; // used as the analysis when you skip analysis and write no analysis text

const HASHTAGS_MAX = 5; // research on Instagram reach favours 3 to 5 relevant hashtags over many

/** Takes the hashtags off the last line of a caption, when that line holds only hashtags. */
function splitHashtags(caption: string): { text: string; tags: string[] } {
  const lines = caption.split("\n");
  const words = lines[lines.length - 1].trim().split(/\s+/).filter(Boolean);
  if (lines.length > 1 && words.length && words.every((w) => /^#\S+$/.test(w))) {
    return { text: lines.slice(0, -1).join("\n").trim(), tags: words };
  }
  return { text: caption, tags: [] };
}

export function normalizePlan(p: Partial<Plan>): Plan {
  const missing = (["caption", "commentBody", "imagePrompt"] as const).filter((k) => !p[k]?.trim());
  if (missing.length) throw new Error(`The caption step returned an incomplete result, missing: ${missing.join(", ")}`);

  // The hashtags stay on their own last line, at most five. The pointer goes above them.
  const { text, tags } = splitHashtags(p.caption!.trim());
  const tagLine = tags.slice(0, HASHTAGS_MAX).join(" ");
  const room = MAX_TEXT - POINTER.length - tagLine.length - 6; // room for the separators
  const body = text.length > room ? text.slice(0, room) : text;
  const caption = [body, /pinned comment/i.test(body) ? "" : POINTER, tagLine].filter(Boolean).join("\n\n");

  return {
    caption,
    // Long descriptions are split into numbered comments when posted, so the limit here is the total of all parts.
    commentBody: p.commentBody!.trim().slice(0, COMMENT_TOTAL_LIMIT),
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
  const isCarousel = (d.format ?? "post") === "carousel";

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
      const style = d.research === "quick" ? "quick search and check" : "deep research";
      return { state: "researching", note: `Started: ${style} (mode: ${p.mode})` };
    }

    case "researching": {
      if (d.research === "quick") return quickResearch(job, models);
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
      if (isCarousel) return analyzeCarousel(job, wf, models);
      if (!d.report) throw new Error("No research report stored. Retry from the research step.");
      if (wf.skipAnalysis) {
        const typed = (manual.imagePrompt ?? "").trim();
        if (!typed) throw new Error("No image prompt was written. Add it on the job page, or turn off Skip analysis.");
        const analysis = (manual.analysis ?? d.report.slice(0, ANALYSIS_EXCERPT)).trim();
        // Your prompt is used as the picture, with the picture rules added for a square picture.
        const pictureParts = partsFromText(typed);
        return {
          state: "generating",
          data: { analysis, imagePrompt: composePicturePrompt(pictureParts, "square"), pictureParts, report: null },
          note: `Analysis skipped. Your image prompt is used, with ${manual.analysis ? "your analysis text" : "the start of the report as the analysis"}. Make the picture and upload it on the job page.`,
        };
      }
      const a = await p.gemini.analyze({ topic: job.topic, report: d.report, model: models.analysis });
      if (!a.analysis.trim() || !a.imagePrompt.trim()) {
        throw new Error("The analysis came back without an analysis or an image prompt. Retry this step.");
      }
      return {
        state: "generating",
        data: { analysis: a.analysis.trim(), imagePrompt: a.imagePrompt.trim(), pictureParts: a.parts ?? null, report: null },
        note: `Analysis ready from a separate Gemini chat (${a.analysis.length.toLocaleString()} characters). The report was ${
          a.reportVia === "attached"
            ? `attached as ${REPORT_FILE}`
            : "pasted into the prompt, because the Gemini server does not take file attachments yet"
        }. Make the picture from its prompt and upload it on the job page.`,
        detail: { imagePrompt: a.imagePrompt },
      };
    }

    case "generating": {
      // Your pictures are made by hand and uploaded on the job page. Nothing runs here: Continue starts the caption.
      return { state: "generating", pending: true, quiet: true, note: "Waiting for your pictures" };
    }

    case "verifying": {
      // The Gemini picture check has left the workflow. A job that was still in it goes on to the caption.
      return {
        state: "captioning",
        data: { verdict: { pass: true, issues: [], skipped: true } },
        note: "The Gemini picture check no longer runs. Going on to the caption.",
      };
    }

    case "captioning": {
      // Every picture must be uploaded before the caption. A job that gets here without them waits for them.
      const missing = missingPictures(d);
      if (missing.length) {
        return {
          state: "generating",
          note: `Waiting for your pictures: ${missing.map((i) => i + 1).join(", ")} still to upload`,
        };
      }
      // A carousel's pictures get their text here. The uploaded pictures are kept as they are.
      const slidesDone = isCarousel ? await composeCarousel(job) : 0;
      let plan: Plan;
      if (wf.skipCaption) {
        plan = normalizePlan({ caption: manual.caption, commentBody: manual.commentBody, imagePrompt: d.imagePrompt ?? "" });
      } else {
        if (!d.analysis) throw new Error("No analysis stored. Retry from the analysis step.");
        const c = await p.gemini.caption({ topic: job.topic, analysis: d.analysis, model: models.caption });
        plan = normalizePlan({ ...c, imagePrompt: d.imagePrompt });
      }
      // A quick research job puts its sources at the end of the pinned comment, so readers can check the facts.
      if (d.quick?.cited?.length) plan = { ...plan, commentBody: withSources(plan.commentBody, d.quick.cited) };
      // Continue on the job page is the go-ahead, so the post goes out next. Jobs made before that still wait for approval.
      const post = d.manualContinue === true;
      return {
        state: post ? "publishing" : "awaiting_review",
        data: { plan },
        note: `${slidesDone ? `Text drawn on ${slidesDone} slides. ` : ""}${wf.skipCaption ? "Caption written by you" : "Caption ready"} (${plan.caption.length} characters with hashtags), pinned comment ${plan.commentBody.length} characters in ${splitComment(plan.commentBody).length} comment(s). ${
          post ? "Going on to the post." : "Waiting for your approval."
        }`,
      };
    }

    case "publishing": {
      const plan = d.plan!;
      const dryRun = p.mode === "mock";
      const tag = dryRun ? "DRY RUN: " : "";
      const pub = { ...(d.publish ?? {}) };

      // Each sub-step is saved before the next one runs, so a retry never posts the photo twice.
      if (!pub.mediaId && isCarousel) {
        // One album post with the slides in order. Each picture has its own signed link for its slide.
        const slides = d.slideImages ?? [];
        const planned = d.carousel?.slides.length ?? 0;
        if (!planned) throw new Error("No carousel plan stored. Retry from the analysis step.");
        const imageUrls: string[] = [];
        for (let i = 0; i < planned; i++) {
          const img = slides[i];
          if (!img) throw new Error(`No picture stored for slide ${i + 1}. Upload it on the job page.`);
          imageUrls.push(dryRun ? "mock://draft" : publicMediaUrl(job.id, img.attempt, i));
        }
        const album = await p.instagram.postAlbum({ imageUrls, caption: plan.caption, aspect: d.design?.shape ?? "square" });
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
      // A long description goes out as numbered comments, 1/3, 2/3, ... The first is pinned. Each part is saved
      // as soon as it is posted, so a retry never posts a part twice.
      const parts = splitComment(plan.commentBody);
      const ids = pub.commentIds ?? (pub.commentId ? [pub.commentId] : []);
      if (ids.length === 0) {
        const c = await p.instagram.comment({ mediaId: pub.mediaId, text: parts[0] });
        return {
          state: "publishing",
          data: { publish: { ...pub, commentIds: [c.commentId], commentId: c.commentId } },
          note: `${tag}detail comment 1 of ${parts.length} posted (${c.commentId})`,
          detail: c.raw,
        };
      }
      if (!pub.pinned) {
        await p.instagram.pin({ commentId: ids[0], mediaId: pub.mediaId });
        return {
          state: "publishing",
          data: { publish: { ...pub, commentIds: ids, commentId: ids[0], pinned: true } },
          note: `${tag}detail comment 1 of ${parts.length} pinned`,
        };
      }
      if (ids.length < parts.length) {
        const k = ids.length;
        const c = await p.instagram.comment({ mediaId: pub.mediaId, text: parts[k] });
        return {
          state: "publishing",
          data: { publish: { ...pub, commentIds: [...ids, c.commentId] } },
          note: `${tag}detail comment ${k + 1} of ${parts.length} posted (${c.commentId})`,
          detail: c.raw,
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
