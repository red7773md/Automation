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

export const VERIFY_PROMPT = `You are checking an AI-generated image before it is posted to Instagram.
Post topic: {topic}
Image prompt that was used: {prompt}

Check the attached image for:
1. It matches the topic and the prompt.
2. No garbled, misspelled or unreadable text.
3. No distorted faces, hands or extra limbs.
4. No watermarks, logos or brand names.
5. It looks clean and suitable for Instagram.

Return ONLY a JSON object:
{"pass": true or false, "issues": ["one short sentence per problem"], "revisedPrompt": "a complete improved image prompt that fixes the problems (only when pass is false, otherwise an empty string)"}
Do not write anything outside the JSON.`;

export function fill(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) out = out.split("{" + key + "}").join(value);
  return out;
}
