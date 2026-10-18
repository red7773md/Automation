import { adminRoute, json } from "@/lib/api";
import { WORKFLOW_HINT, WORKFLOW_KEYS, WORKFLOW_LABEL, normalizeWorkflow } from "@/lib/jobs/workflow";
import { MODEL_PRESETS, TASKS, TASK_HINT, TASK_LABEL, loadModels, loadWorkflow, normalizeModels, saveModels, saveWorkflow } from "@/lib/settings";

export const GET = adminRoute(async () => {
  return json({
    models: await loadModels(),
    presets: MODEL_PRESETS,
    tasks: TASKS.map((id) => ({ id, label: TASK_LABEL[id], hint: TASK_HINT[id] })),
    workflow: await loadWorkflow(),
    workflowSwitches: WORKFLOW_KEYS.map((id) => ({ id, label: WORKFLOW_LABEL[id], hint: WORKFLOW_HINT[id] })),
  });
});

// Each part is optional, so the model card and the workflow card can save on their own.
export const PUT = adminRoute(async (req) => {
  const body = (await req.json().catch(() => null)) as { models?: unknown; workflow?: unknown } | null;
  const out: Record<string, unknown> = {};
  if (body?.models !== undefined) {
    const models = normalizeModels(body.models);
    await saveModels(models);
    out.models = models;
  }
  if (body?.workflow !== undefined) {
    const workflow = normalizeWorkflow(body.workflow);
    await saveWorkflow(workflow);
    out.workflow = workflow;
  }
  if (Object.keys(out).length === 0) return json({ error: "Nothing to save" }, 400);
  return json(out);
});
