// The design review prompts: the registry, and the digest computed in code. A reviewer run records the prompt's id, version and digest (ReviewerRunSchema), so the card shows exactly which text a reviewer was given.
import { createHash } from "node:crypto";
import type { ReviewerRole } from "@agentx/contracts";
import type { ReviewPrompt } from "./common.js";
import { CODEBASE_PROMPT } from "./codebase.js";
import { COMPREHENSION_PROMPT } from "./comprehension.js";
import { CRITIC_B_PROMPT } from "./critic-b.js";
import { CRITIC_PROMPT } from "./critic.js";
import { MERGE_PROMPT } from "./merge.js";
import { RESOLVE_PROMPT } from "./resolve.js";
import { ZOOM_OUT_PROMPT } from "./zoom-out.js";

export type { ReviewPrompt } from "./common.js";
export { MATERIAL_MARKER } from "./common.js";
export { CODEBASE_PROMPT, COMPREHENSION_PROMPT, CRITIC_B_PROMPT, CRITIC_PROMPT, MERGE_PROMPT, RESOLVE_PROMPT, ZOOM_OUT_PROMPT };

/** One prompt per reviewer role. The role decides the prompt; a reviewer cannot pick another. */
export const REVIEWER_PROMPTS: Readonly<Record<ReviewerRole, ReviewPrompt>> = {
  comprehension: COMPREHENSION_PROMPT,
  critic: CRITIC_PROMPT,
  codebase: CODEBASE_PROMPT,
  zoom_out: ZOOM_OUT_PROMPT,
  critic_b: CRITIC_B_PROMPT,
};
export const ALL_DESIGN_REVIEW_PROMPTS: readonly ReviewPrompt[] = [...Object.values(REVIEWER_PROMPTS), MERGE_PROMPT, RESOLVE_PROMPT];

/** The SHA-256 of the prompt's id, version and text, as 64 hex characters. */
export function promptDigest(prompt: ReviewPrompt): string {
  return createHash("sha256").update(`${prompt.id}\n${prompt.version}\n${prompt.text}`).digest("hex");
}

/** The three fields of a `ReviewerRun` that name its prompt. */
export function promptRecord(prompt: ReviewPrompt): { promptId: string; promptVersion: number; promptDigest: string } {
  return { promptId: prompt.id, promptVersion: prompt.version, promptDigest: promptDigest(prompt) };
}
