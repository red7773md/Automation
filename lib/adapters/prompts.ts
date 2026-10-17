// Prompts sent to Gemini through MCP. The HTTP bridge has its own copy in Python.
export const PLAN_PROMPT = `You are preparing an Instagram post from a research report.
Return ONLY a JSON object with exactly these three string keys:
- "caption": a short hook (at most two sentences) followed by 5 to 10 relevant hashtags.
- "commentBody": the detailed description for the first comment, factual and readable, at most 1800 characters, using short paragraphs or bullet lines.
- "imagePrompt": a detailed prompt for an image generator. Square composition. No text, letters or numbers in the image. No real people's faces, logos or brand names.
Do not wrap the JSON in markdown fences and do not write anything outside the JSON.

Topic: {topic}

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
