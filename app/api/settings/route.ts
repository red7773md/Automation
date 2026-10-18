import { adminRoute, json } from "@/lib/api";
import { MODEL_PRESETS, TASKS, TASK_HINT, TASK_LABEL, loadModels, normalizeModels, saveModels } from "@/lib/settings";

export const GET = adminRoute(async () => {
  return json({
    models: await loadModels(),
    presets: MODEL_PRESETS,
    tasks: TASKS.map((id) => ({ id, label: TASK_LABEL[id], hint: TASK_HINT[id] })),
  });
});

export const PUT = adminRoute(async (req) => {
  const body = (await req.json().catch(() => null)) as { models?: unknown } | null;
  const models = normalizeModels(body?.models);
  await saveModels(models);
  return json({ models });
});
