// K1 lane D, D2: the broker's own reading of a SPEC_WRITE result. The worker's copy is never trusted: the draft is parsed again, must be for the approved plan, and is rendered here by the project's format.
import { SPEC_FILE_MAX_BYTES, SPEC_REVIEW_REQUIREMENTS_MAX, SpecDraftSchema, type SpecFile } from "@agentx/contracts";
import { specRendererFor } from "./index.js";
import type { SpecFailureCode, SpecState } from "./state.js";

export type AcceptedSpec = { ok: true; title: string; folder: string; files: SpecFile[]; requirementCount: number } | { ok: false; code: SpecFailureCode };

export interface AcceptSpecInput {
  /** The SPEC_WRITE operation's result, as the worker reported it. */
  result: unknown;
  state: SpecState;
  /** The digest of the plan that is approved now. */
  approvedPlanDigest: string;
  taskKey: string;
  ticket?: string | undefined;
  /** Folder names in the spec folder's parent at `knowledgeCommit` (for `{n}`), and the team's template files (for `team_template`). */
  existingFolders: readonly string[];
  template?: readonly SpecFile[] | undefined;
}

export function acceptSpecWrite(input: AcceptSpecInput): AcceptedSpec {
  const reported = input.result !== null && typeof input.result === "object" ? (input.result as { specDraft?: unknown }).specDraft : undefined;
  const parsed = SpecDraftSchema.safeParse(reported);
  if (!parsed.success) return { ok: false, code: "unreadable" };
  const draft = parsed.data;
  // The plan can move on while the spec is written (a revision approved meanwhile); a spec of an older plan is not published.
  if (draft.planDigest !== input.state.planDigest || input.state.planDigest !== input.approvedPlanDigest) return { ok: false, code: "plan_changed" };
  if (draft.kind !== input.state.kind) return { ok: false, code: "unreadable" };
  const renderer = specRendererFor(input.state.target.format);
  if (renderer === undefined) return { ok: false, code: "unsupported" };
  if (input.state.target.format === "team_template" && (input.template === undefined || input.template.length === 0)) return { ok: false, code: "template_missing" };
  try {
    const rendered = renderer.render({ draft, target: input.state.target, taskKey: input.taskKey, ...(input.ticket === undefined ? {} : { ticket: input.ticket }), existingFolders: input.existingFolders, ...(input.template === undefined ? {} : { template: input.template }) });
    const requirements = renderer.extractRequirements(rendered.files).filter((entry) => entry.kind === "requirement");
    // A spec with nothing to check is not a spec; one with more than a review walks is cut by the review, not here.
    if (requirements.length === 0 || rendered.files.some((file) => new TextEncoder().encode(file.content).byteLength > SPEC_FILE_MAX_BYTES)) return { ok: false, code: "render_failed" };
    return { ok: true, title: draft.title, folder: rendered.folder, files: rendered.files, requirementCount: Math.min(requirements.length, SPEC_REVIEW_REQUIREMENTS_MAX * 2) };
  } catch {
    return { ok: false, code: "render_failed" };
  }
}
