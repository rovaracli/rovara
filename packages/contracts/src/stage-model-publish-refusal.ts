// "How we work" (V3): what a refused publish, confirm or rollback says when a model choice of the process layer can't be resolved. The resolver's fixed refusal codes travel in the existing
// error shape (`{ error: { code, message } }`) as one fixed line, so no new error code or field is needed: the page reads the line back and shows the fixed sentence of each code.
import { STAGE_IDS, STAGE_MODEL_REFUSAL_CODES, type StageId, type StageModelRefusalCode } from "./stage-model-shared.js";

export interface StageRefusal {
  code: StageModelRefusalCode;
  stage: StageId;
  /** A same-origin page that helps fix it; only ever one of the app paths the server knows. */
  fixHref?: string;
}

/** The start of the message; the refusals follow, separated by "; ". */
export const STAGE_REFUSAL_MESSAGE_PREFIX = "Model choices can't be published: ";
/** The most refusals one message carries: one per stage. */
export const STAGE_REFUSALS_MAX = STAGE_IDS.length;
const FIX_HREF = /^\/app\/[a-zA-Z0-9_/-]{1,200}$/u;
const ITEM = /^([A-Z_]{3,40}) ([a-z_]{2,40})(?: (\/app\/[a-zA-Z0-9_/-]{1,200}))?$/u;

/** The message of a refused publish: the prefix, then each refusal as `CODE stage` with its fix page when it has one. */
export function stageRefusalMessage(refusals: readonly StageRefusal[]): string {
  return STAGE_REFUSAL_MESSAGE_PREFIX + refusals.slice(0, STAGE_REFUSALS_MAX).map((refusal) => `${refusal.code} ${refusal.stage}${refusal.fixHref !== undefined && FIX_HREF.test(refusal.fixHref) ? ` ${refusal.fixHref}` : ""}`).join("; ");
}

/** The refusals a message carries, or undefined when it is anything else (a message with one unknown word is not read at all, so the page falls back to the plain message). */
export function parseStageRefusalMessage(message: string): StageRefusal[] | undefined {
  if (!message.startsWith(STAGE_REFUSAL_MESSAGE_PREFIX)) return undefined;
  const parts = message.slice(STAGE_REFUSAL_MESSAGE_PREFIX.length).split("; ");
  if (parts.length === 0 || parts.length > STAGE_REFUSALS_MAX) return undefined;
  const found: StageRefusal[] = [];
  for (const part of parts) {
    const match = ITEM.exec(part);
    const code = match?.[1] as StageModelRefusalCode | undefined, stage = match?.[2] as StageId | undefined;
    if (match === null || code === undefined || stage === undefined || !(STAGE_MODEL_REFUSAL_CODES as readonly string[]).includes(code) || !(STAGE_IDS as readonly string[]).includes(stage)) return undefined;
    found.push({ code, stage, ...(match[3] === undefined ? {} : { fixHref: match[3] }) });
  }
  return found;
}
