// The carousel branch of the pipeline. Research and the caption are shared with a single post. The plan
// (from Gemini, or written by hand) is made here, the pictures are made by hand and uploaded on the job page,
// the text is drawn over each uploaded picture, and then one album post goes out.
import { providers } from "@/lib/adapters";
import type { CarouselPlan } from "@/lib/adapters/types";
import { finalDraftPath, readDraft, saveDraft } from "@/lib/blob";
import { shrinkForSending } from "@/lib/images";
import { composeSlide } from "@/lib/overlay";
import type { ModelSettings } from "@/lib/settings";
import { loadCarousel } from "@/lib/settings";
import { CAROUSEL_DEFAULT, slidesFromLines } from "./carousel";
import { DESIGN_DEFAULT, sizeOf, type SlideDesign } from "./design";
import type { JobRow } from "./states";
import type { StepResult } from "./steps";
import type { Workflow } from "./workflow";

const ANALYSIS_EXCERPT = 1500; // used as the analysis when you skip analysis and write no analysis text

/** Stands in for the single image prompt on a carousel: one numbered line per slide. */
function summary(plan: CarouselPlan): string {
  return plan.slides.map((s, i) => `${i + 1}. ${s.imagePrompt}`).join("\n");
}

/** The look of the carousel as it is when the job starts. A job keeps this even if Settings change later. */
async function designForJob(job: JobRow): Promise<SlideDesign> {
  if (job.data.design) return job.data.design;
  const { shape, handle, footer } = await loadCarousel();
  return { shape, handle, footer };
}

/** Makes the plan: the angle, the shared look and one picture prompt per slide. Then the pictures are waited for. */
export async function analyzeCarousel(job: JobRow, wf: Workflow, models: ModelSettings): Promise<StepResult> {
  const d = job.data;
  const count = d.slideCount ?? CAROUSEL_DEFAULT;
  const manual = d.manual ?? {};
  const design = await designForJob(job);
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
    plan = await providers().gemini.analyzeCarousel({ topic: job.topic, report: d.report, slideCount: count, shape: design.shape, model: models.analysis });
    note = `Carousel plan ready from a separate Gemini chat: ${plan.slides.length} slides (up to ${count} chosen), ${design.shape} pictures`;
  }
  return {
    state: "generating",
    data: {
      format: "carousel",
      slideCount: count,
      design,
      carousel: plan,
      analysis: plan.analysis,
      imagePrompt: summary(plan),
      report: null,
      slideImages: plan.slides.map(() => null),
    },
    note: `${note}. Make each picture from its prompt and upload it on the job page.`,
  };
}

/**
 * Writes each slide's text onto its uploaded picture and saves the result as the picture that is posted.
 * The uploaded picture is not changed. Running this again rebuilds the same pictures from the uploaded ones.
 */
export async function composeCarousel(job: JobRow): Promise<number> {
  const d = job.data;
  const plan = d.carousel;
  if (!plan) throw new Error("No carousel plan stored. Retry from the analysis step.");
  const design = d.design ?? DESIGN_DEFAULT;
  const images = d.slideImages ?? [];
  const total = plan.slides.length;
  for (let i = 0; i < total; i++) {
    const img = images[i];
    if (!img) throw new Error(`No picture stored for slide ${i + 1}. Upload it on the job page.`);
    const uploaded = await readDraft(img.path);
    const picture = await composeSlide(uploaded.bytes, { ...plan.slides[i], design, index: i, total });
    const shrunk = await shrinkForSending(picture, sizeOf(design.shape));
    await saveDraft(finalDraftPath(job.id, img.attempt, i), shrunk.bytes, shrunk.contentType);
  }
  return total;
}
