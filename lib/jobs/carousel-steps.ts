// The carousel branch of the pipeline. Research and the caption are shared with a single post. The
// analysis, the pictures, their check and the publishing are the carousel's own: one picture per
// slide, each checked before the next slide is made, then one album post.
import { providers } from "@/lib/adapters";
import type { CarouselPlan, Verdict } from "@/lib/adapters/types";
import { draftPath, readDraft, saveDraft } from "@/lib/blob";
import { shrinkForSending } from "@/lib/images";
import type { ModelSettings } from "@/lib/settings";
import { CAROUSEL_DEFAULT, CAROUSEL_TRIES, carouselVerdict, expectedText, slidePrompt, slidesFromLines } from "./carousel";
import type { JobRow, SlideImage } from "./states";
import type { StepResult } from "./steps";
import type { Workflow } from "./workflow";

const kb = (bytes: number) => (bytes / 1024).toFixed(0);
const ANALYSIS_EXCERPT = 1500; // used as the analysis when you skip analysis and write no analysis text

/** Stands in for the single image prompt on a carousel: one numbered line per slide. */
function summary(plan: CarouselPlan): string {
  return plan.slides.map((s, i) => `${i + 1}. ${s.imagePrompt}`).join("\n");
}

export async function analyzeCarousel(job: JobRow, wf: Workflow, models: ModelSettings): Promise<StepResult> {
  const d = job.data;
  const count = d.slideCount ?? CAROUSEL_DEFAULT;
  const manual = d.manual ?? {};
  let plan: CarouselPlan;
  let note: string;
  if (wf.skipAnalysis) {
    // Your own prompts, one per line. The first line is the hook.
    const slides = slidesFromLines(manual.slides ?? "", count);
    plan = {
      analysis: (manual.analysis ?? (d.report ?? "").slice(0, ANALYSIS_EXCERPT)).trim(),
      styleGuide: "",
      slides,
    };
    note = `Analysis skipped. Your ${slides.length} slide prompts are used.`;
  } else {
    if (!d.report) throw new Error("No research report stored. Retry from the research step.");
    plan = await providers().gemini.analyzeCarousel({ topic: job.topic, report: d.report, slideCount: count, model: models.analysis });
    note = `Carousel plan ready from a separate Gemini chat: ${plan.slides.length} slides (up to ${count} chosen)`;
  }
  return {
    state: "generating",
    data: {
      format: "carousel",
      slideCount: count,
      carousel: plan,
      analysis: plan.analysis,
      imagePrompt: summary(plan),
      report: null,
      slideImages: [],
      slideIndex: 0,
      slideFix: null,
      nextPrompt: null,
    },
    note,
  };
}

/** Makes the picture of the current slide. Each slide is one step, so a slow image never holds up the others. */
export async function generateSlide(job: JobRow, models: ModelSettings): Promise<StepResult> {
  const d = job.data;
  const plan = d.carousel;
  if (!plan) throw new Error("No carousel plan stored. Retry from the analysis step.");
  const i = d.slideIndex ?? 0;
  const slide = plan.slides[i];
  if (!slide) throw new Error(`Slide ${i + 1} is not in the plan. Retry from the analysis step.`);

  const fix = d.slideFix && d.slideFix.index === i ? d.slideFix : undefined;
  // A reviewer's notes from a rejection apply to every slide of the new set.
  const notes = [...(fix?.notes ?? []), ...(d.reviewFeedback ? [`Reviewer notes: ${d.reviewFeedback}`] : [])];
  const prompt = slidePrompt(plan.styleGuide, { ...slide, imagePrompt: fix?.imagePrompt || slide.imagePrompt }, { index: i, total: plan.slides.length }, notes);

  const p = providers();
  const image =
    process.env.IMAGE_PROVIDER === "chatgpt"
      ? await p.chatgpt.generateImage(prompt)
      : await p.gemini.generateImage(prompt, models.image);
  const attempt = job.attempts + 1;
  const shrunk = await shrinkForSending(image.bytes);
  const path = await saveDraft(draftPath(job.id, attempt, i), shrunk.bytes, shrunk.contentType);

  const images: SlideImage[] = [...(d.slideImages ?? [])];
  const made: SlideImage = { attempt, path, tries: (images[i]?.tries ?? 0) + 1 };
  images[i] = made;
  return {
    state: "verifying",
    attempts: attempt,
    data: { slideImages: images, draftPath: path, lastPrompt: prompt, slideFix: null, slideIndex: i },
    note: `Slide ${i + 1} of ${plan.slides.length} made (try ${made.tries} of ${CAROUSEL_TRIES}, attempt ${attempt}): ${kb(image.bytes.length)} KB original, ${kb(shrunk.bytes.length)} KB JPEG ${shrunk.width}×${shrunk.height}, privately`,
    detail: { prompt },
  };
}

/** Checks the current slide against its prompt and its headline. */
export async function verifySlide(job: JobRow, wf: Workflow, models: ModelSettings): Promise<StepResult> {
  const d = job.data;
  const plan = d.carousel;
  if (!plan) throw new Error("No carousel plan stored. Retry from the analysis step.");
  const total = plan.slides.length;
  const i = d.slideIndex ?? 0;
  const slide = plan.slides[i];
  const images: SlideImage[] = [...(d.slideImages ?? [])];
  const img = images[i];
  if (!slide || !img) throw new Error(`Slide ${i + 1} has no picture stored. Retry from the image step.`);

  if (wf.skipVerify) {
    images[i] = { ...img, pass: true, issues: [] };
    return nextSlide(i, total, images, wf, `Image check skipped for slide ${i + 1} (your setting).`);
  }

  const stored = await readDraft(img.path);
  const verdict = await providers().gemini.verifyImage({
    topic: job.topic,
    imagePrompt: d.lastPrompt ?? slide.imagePrompt,
    image: stored.bytes,
    mimeType: stored.contentType,
    attempt: job.attempts,
    model: models.verify,
    expectedText: expectedText(slide),
  });
  images[i] = { ...img, pass: verdict.pass, issues: verdict.issues };
  return afterCheck(i, total, img, verdict, images, wf);
}

/**
 * What one slide's check leads to: the same slide again (once), the next slide, or the caption
 * with the verdict for the whole set after the last slide. A slide that fails twice moves on, and
 * the set then waits for your decision.
 */
export function afterCheck(i: number, total: number, img: SlideImage, verdict: Verdict, images: SlideImage[], wf: Workflow): StepResult {
  const label = `Slide ${i + 1} of ${total}`;
  const issues = verdict.issues.length ? verdict.issues.join("; ") : "no issues listed";
  if (verdict.pass) return nextSlide(i, total, images, wf, `${label} passed the check.`, verdict);
  if (img.tries < CAROUSEL_TRIES) {
    return {
      state: "generating",
      data: {
        slideImages: images,
        slideIndex: i,
        slideFix: {
          index: i,
          notes: verdict.issues.length ? verdict.issues : ["the picture did not match the slide"],
          imagePrompt: verdict.revisedPrompt,
        },
      },
      note: `${label} failed the check (${issues}). Making this slide again.`,
      detail: verdict,
    };
  }
  return nextSlide(i, total, images, wf, `${label} failed the check twice (${issues}). Moving on; you decide at approval.`, verdict);
}

function nextSlide(i: number, total: number, images: SlideImage[], wf: Workflow, note: string, detail?: unknown): StepResult {
  if (i + 1 < total) {
    return { state: "generating", data: { slideImages: images, slideIndex: i + 1, slideFix: null }, note, detail };
  }
  const verdict = carouselVerdict(images, total, wf.skipVerify);
  return {
    state: "captioning",
    data: { slideImages: images, verdict },
    note: `${note} All ${total} slides are made${verdict.pass ? " and passed the check" : ", and some did not pass the check"}.`,
    detail: verdict,
  };
}
