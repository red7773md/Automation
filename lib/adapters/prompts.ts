// Prompts sent to Gemini through MCP. The HTTP bridge has its own copy in Python.

/** File name the research report is sent under, so Gemini reads it as a Markdown document. */
export const REPORT_FILE = "research-report.md";

/** Put in the prompt in place of the report when the report is attached as a file. */
export const REPORT_ATTACHED = `The full research report is attached as ${REPORT_FILE}. Read all of it before answering.`;

export const ANALYZE_PROMPT = `You are preparing an Instagram post from a deep research report. A person makes the picture by hand in an image generator, from the description you write, so the description must be concrete and complete.
Return ONLY a JSON object with exactly these two keys:
- "analysis": the key findings, what matters most to a general audience, and the angle that will work best on Instagram. Plain language, at most 1500 characters.
- "picture": the picture for this post, as an object with these string keys:
  - "subject": the one main thing in the picture, in one sentence.
  - "scene": the setting and concrete details: objects, place, time of day, what is happening. 2 to 4 sentences.
  - "composition": the framing, the camera angle, where the subject sits, and the open space the picture leaves.
  - "lighting": the light source, its direction and quality.
  - "palette": the main colours, in words.
  - "style": the art or photo style, and how detailed it is.
  - "mood": the feeling the picture gives.
  - "avoid": what must not appear: real people's faces, brand names, logos, and text of any kind.
  Describe the picture in about 400 to 800 characters across its values together. It is one square picture, with no text, letters or numbers in it.
Do not wrap the JSON in markdown fences and do not write anything outside the JSON.

Topic: {topic}

Research report:
{report}
`;

export const CAPTION_PROMPT = `You are writing the text for an Instagram post. The image is already made, and the analysis below describes the angle.
Return ONLY a JSON object with exactly these two string keys:
- "caption": a short hook (at most two sentences), then 3 to 5 hashtags on the last line. Choose hashtags that match this topic and the words people search for: one or two broad tags, one or two medium tags and one niche tag. Never use generic tags such as #love, #instagood or #photooftheday. Keep the whole caption under 1200 characters.
- "commentBody": the detailed description for the pinned comment: factual and readable, short paragraphs or bullet lines, at most 3000 characters. The app splits a long description into numbered comments, so write it in full. Do not repeat the hashtags here.
Do not wrap the JSON in markdown fences and do not write anything outside the JSON.

Topic: {topic}

Analysis:
{analysis}
`;

export const CAROUSEL_PROMPT = `You are planning an Instagram carousel post from a deep research report. The viewer swipes through the slides in order. The app draws the text over each picture, so the pictures contain no text at all.
Return ONLY a JSON object with exactly these keys:
- "analysis": the angle of the post and the key findings, in plain language, at most 1500 characters.
- "styleGuide": one or two sentences on the look shared by every picture: colours, art or photo style, lighting and level of detail. At most 300 characters.
- "slides": a list of at most {count} objects, in swipe order. Use {count} slides when the topic needs that many. Use fewer when it does not, but never fewer than 3. Each object has:
  - "role": "hook" for the first slide, "cta" for the last slide, "point" for every other slide.
  - "figure": only on the hook slide, one short number or figure from the report that makes the viewer stop, for example "3x" or "70%", at most 16 characters. Use "" when the report has no clear figure, and "" on every other slide.
  - "headline": the short text the app draws large on the picture, at most 60 characters.
  - "body": one short line of essential information under the headline, at most 150 characters. Only the essentials: the full detail belongs in the post's description, not on the slides. May be empty.
  - "picture": this slide's picture, as an object with these string keys:
    - "subject": the one main thing in the picture, in one sentence.
    - "scene": the setting and concrete details: objects, place, time of day, what is happening. 2 to 4 sentences.
    - "composition": the framing, the camera angle, where the subject sits, and the open space the picture leaves for the text the app draws.
    - "lighting": the light source, its direction and quality.
    - "palette": the main colours, in words.
    - "style": the art or photo style, and how detailed it is.
    - "mood": the feeling the picture gives.
    - "avoid": what must not appear: real people's faces, brand names, logos, and text of any kind.
    Describe each picture in about 400 to 800 characters across its values together. Do not put the slide's headline or body into the picture: the app writes them on it.

The app adds these picture rules to every picture, so describe each picture to match them:
{rules}

Rules for the slides:
- The first slide is the hook. Open a curiosity gap: a figure or a surprising fact, and a question the viewer wants answered. Give the brief point, but not the whole answer, so the viewer swipes to learn more.
- Each following slide makes one point, in order, and builds on the slide before it. Each headline makes sense when read alone.
- The last slide is the call to action: a short takeaway and a reason to save or follow the account.
- Every picture matches the styleGuide, so the set looks like one post.
- Every figure, fact and number must come from the research report. Do not invent any.

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
{"pass": true or false, "issues": ["one short sentence per problem"], "revisedPrompt": "a complete improved image prompt under 400 characters that fixes the problems and describes only the picture, with no logo, watermark or text (only when pass is false, otherwise an empty string)"}
Do not write anything outside the JSON.`;

export const SEARCH_PROMPT = `Give correct, well-established facts about the topic below. Each fact needs the web address of a page that states it.
Return ONLY a JSON object with exactly these keys:
- "summary": two or three sentences on the topic.
- "points": 5 to 8 objects. Each has "claim" (one specific, verifiable fact in one sentence, no opinion), "url" (the full https address of a page that states this fact) and "title" (the page's title).
Every point must have a "url". Use stable pages that are likely to exist and to say the fact: the Wikipedia article for the topic (https://en.wikipedia.org/wiki/ followed by the article title, with spaces replaced by underscores), official documentation, university or government pages, arXiv or DOI paper pages. Use a different page where you can.
The app opens every page and checks each fact against its text, and drops any fact the page does not support. So give the best address you know for each fact; an address you are not certain of is still useful. Do not invent facts.
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
