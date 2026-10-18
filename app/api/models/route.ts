import { providers } from "@/lib/adapters";
import type { AccountModel, AccountModels } from "@/lib/adapters/types";
import { adminRoute, json } from "@/lib/api";
import { errorMessage } from "@/lib/logger";
import { MODEL_PRESETS } from "@/lib/settings";

// The models the Settings page offers: this account's list from the Gemini server when it has one.
// Otherwise the names the Gemini library knows, so a choice can still be made before the first check.
export const GET = adminRoute(async () => {
  let account: AccountModels;
  try {
    account = await providers().gemini.models();
  } catch (err) {
    account = { models: [], verifiedAt: null, message: errorMessage(err) };
  }
  if (account.models.length) {
    return json({ source: "account", models: account.models, verifiedAt: account.verifiedAt, message: null });
  }
  const library: AccountModel[] = MODEL_PRESETS.map((name) => ({ name, displayName: "", available: true }));
  return json({
    source: "library",
    models: library,
    verifiedAt: null,
    message: `${account.message ?? "The account's model list is not available."} Showing the names the Gemini library knows.`,
  });
});
