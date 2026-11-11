// "How we work" (R2): the comparison the Review changes dialog shows (`GET /v1/app/agents/{id}/diff`). A publish of a project's process layer asks a second person for the ordinary less-safe
// reasons and the process layer's own (`lessSafeChangesFor`), so the dialog lists the same ones, not fewer. A comparison from the base (`from: "base"`) is a first publish.
import type { ResolvedRecipe } from "@rovara-code/contracts";
import { lessSafeChangesFor } from "./process-less-safe.js";

export const diffLessSafe = (agent: { purpose?: string | undefined }, before: ResolvedRecipe, after: ResolvedRecipe, from: number | "base" | "draft"): string[] =>
  lessSafeChangesFor(agent, before, after, { firstPublish: from === "base" });
