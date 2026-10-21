// Prompts sent to Gemini through MCP. The HTTP bridge has its own copy in Python.

/** File name the research report is sent under, so Gemini reads it as a Markdown document. */
export const REPORT_FILE = "research-report.md";

/** Put in the prompt in place of the report when the report is attached as a file. */
export const REPORT_ATTACHED = `The full research report is attached as ${REPORT_FILE}. Read all of it before answering.`;

export const ANALYZE_PROMPT = `You are preparing an Instagram post from a deep research report.
Return ONLY a JSON object with exactly these two string keys:
- "analysis": the key findings, what matters most to a general audience, and the angle that will work best on Instagram. Plain language, at most 1500 characters.
- "imagePrompt": a detailed prompt for an image generator that suits this angle. Square composition. No text, letters or numbers in the image. No real people's faces, logos or brand names.
Do not wrap the JSON in markdown fences and do not write anything outside the JSON.

Topic: {topic}

Research report:
{report}
`;

export const CAPTION_PROMPT = `You are writing the text for an Instagram post. The image is already made, and the analysis below describes the angle.
Return ONLY a JSON object with exactly these two string keys:
- "caption": a short hook (at most two sentences), then 8 to 12 relevant hashtags on the last line, chosen to reach people searching for this topic. Keep the whole caption under 1200 characters.
- "commentBody": the detailed description for the pinned comment: factual and readable, short paragraphs or bullet lines, at most 1800 characters. Do not repeat the hashtags here.
Do not wrap the JSON in markdown fences and do not write anything outside the JSON.

Topic: {topic}

Analysis:
{analysis}
`;

export const CAROUSEL_PROMPT = `You are planning an Instagram carousel post from a deep research report. A carousel is a set of square images that the viewer swipes through, one after another.
Return ONLY a JSON object with exactly these keys:
- "analysis": the angle of the post and the key findings, in plain language, at most 1500 characters.
- "styleGuide": one sentence describing the look shared by every slide (colours, style, lighting), at most 300 characters.
- "slides": a list of at most {count} objects, in swipe order. Use {count} slides when the topic needs that many. Use fewer when it does not, but never fewer than 3. Each object has:
  - "role": "hook" for the first slide, "cta" for the last slide, "point" for every other slide.
  - "headline": the short text shown large on the picture, at most 60 characters.
  - "body": one short line of supporting text, at most 120 characters. May be empty.
  - "imagePrompt": a detailed prompt for an image generator that makes this slide's picture. Square composition. Describe only the picture. Do not write any text, letters or numbers in imagePrompt, because the headline and body are added as text. No real people's faces, logos or brand names.

Rules for the slides:
- The first slide is the hook. Open a curiosity gap: a surprising fact, or a question the viewer wants answered. Give the brief point in the headline or body, but do not give the whole answer, so the viewer swipes to learn more.
- Each following slide makes one point, in order, and builds on the slide before it. Each headline makes sense when read alone.
- The last slide is the call to action: a short takeaway and a reason to save or follow the account.
- Every imagePrompt matches the styleGuide, so the set looks like one post.

Do not wrap the JSON in markdown fences and do not write anything outside the JSON.

Topic: {topic}
Number of slides: at most {count}

Research report:
{report}
`;

export const VERIFY_PROMPT = `You are checking an AI-generated image before it is posted to Instagram.
Post topic: {topic}
Image prompt that was used: {prompt}

Check the attached image for:
1. It matches the topic and the prompt.
2. No garbled, misspelled or unreadable text.
3. No distorted faces, hands or extra limbs.
4. No logo, brand mark, watermark, signature, handle or website address anywhere in the picture, even small or in a corner. Fail the check if one appears.
5. It looks clean and suitable for Instagram.
{extra}
Return ONLY a JSON object:
{"pass": true or false, "issues": ["one short sentence per problem"], "revisedPrompt": "a complete improved image prompt that fixes the problems (only when pass is false, otherwise an empty string)"}
Do not write anything outside the JSON.`;

export const SEARCH_PROMPT = `Search the web now for reliable, recent information about the topic below. Use only pages you actually found in that search.
Return ONLY a JSON object with exactly these keys:
- "summary": two or three sentences on what the sources agree on.
- "points": up to 8 objects. Each has "claim" (one specific fact in one sentence, no opinion), "url" (the full address of the page the fact comes from, starting with https://) and "title" (the page's title).
Prefer official, academic, government and major news sources. Do not invent sources or addresses. If you cannot find a source for a fact, leave that fact out.
Do not wrap the JSON in markdown fences and do not write anything outside the JSON.

Topic: {topic}
`;

export const CONFIRM_PROMPT = `You are checking facts against their sources before they are posted publicly.
For each point below, decide whether the source text given for its address states or clearly supports the claim. A claim is supported only when the source text says so. General knowledge is not enough.
Return ONLY a JSON object: {"checks": [{"claim": "...", "url": "...", "supported": true or false, "reason": "one short sentence"}]} with one entry per point, in the same order.
Do not wrap the JSON in markdown fences and do not write anything outside the JSON.

Topic: {topic}

Points to check:
{points}

Sources:
{sources}
`;

export function fill(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) out = out.split("{" + key + "}").join(value);
  return out;
}
