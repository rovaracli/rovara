// "How we work" (H5): the effective view of a project's process, read-only. It is worked out from the recipe the project runs (the built-in Rovara Code at the version the company adopted, then
// the project's process layer at its published version when the playbook points at one), the company's guardrails, the project definition and the project's code settings. Every value says where it
// comes from: a value written in the process layer's overlay is the project's; a value the company's guardrails set is the company's; anything else is Rovara's. The project's own settings (the
// definition and the code settings) are the project's. A value the project cannot change is locked, by the company or by a fact Rovara keeps for safety.
//
// Reviewing stages (the plan check, the review that runs the code and security reviewers, and the pull request feedback review) are not given the process layer's project-wide rules (`wholeAgentLayers`), so those rules are left out of
// their instructions here too, and the stage carries a fixed note the page can show.
import {
  HOW_WE_WORK_INSTRUCTION_MAX,
  HOW_WE_WORK_ITEMS_MAX,
  HOW_WE_WORK_LAYERS_MAX,
  HOW_WE_WORK_LINE_MAX,
  HOW_WE_WORK_REVIEWER_NOTE,
  HOW_WE_WORK_TOOLS_MAX,
  HOW_WE_WORK_TOOL_MAX,
  READ_ONLY_TOOLS,
  ROVARA_CODE_AGENT_ID,
  agentXError,
  builtinDefaultPin,
  builtinRecipe,
  developerTaskPolicy,
  redactText,
  type AgentGuardrails,
  type AgentId,
  type CodeSettings,
  type HowWeWorkSource,
  type HowWeWorkStage,
  type HowWeWorkView,
  type InstructionLayer,
  type Marked,
  type OrgId,
  type RecipeOverlay,
  type ResolvedRecipe,
  type ResolvedStep,
  type StoredProjectDefinition,
} from "@agentx/contracts";
import { crossCompanyTargets } from "../agents/dispatch.js";
import { readGuardrails } from "../agents/guardrails.js";
import { resolveAgent, type AgentStore } from "../agents/store.js";
import { latestRevision } from "../org/project-settings.js";
import { readCodeSettings } from "../rovara-code/code-settings.js";
import { existingLayer } from "./process-layer.js";
import { processUpdate } from "./process-update.js";
import { readStageTrackRecord } from "./track-record.js";
import { isReviewingStage, wholeAgentLayers } from "./process-reviewers.js";
import { readProjectPlaybook } from "./project-playbook-store.js";
import { requireProcessLayer } from "./project-process.js";
import type { ProjectPlaybookDependencies } from "./routes.js";

/** What the view reads: the playbook routes' dependencies, with the whole agent store (the recipe is resolved, never written). */
export interface HowWeWorkDependencies extends Omit<ProjectPlaybookDependencies, "store"> {
  store: AgentStore | undefined;
}

type Lock = "company" | "rovara";
const mark = <T>(value: T, source: HowWeWorkSource, lockedBy?: Lock): Marked<T> => (lockedBy === undefined ? { value, source, locked: false } : { value, source, locked: true, lockedBy });
/** A line of the page: redacted and cut to the contract's limit after it is composed, by code points. */
const fit = (text: string): string => clip(redactText(text), HOW_WE_WORK_LINE_MAX);
const rovara = (text: string, lockedBy?: Lock): Marked<string> => mark(fit(text), "rovara", lockedBy);
const project = (text: string): Marked<string> => mark(fit(text), "project");

const clip = (text: string, max: number): string => {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
};
/** A line a person wrote, redacted and bounded for the page. */
const line = fit;
const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/** The recipe the project runs, the built-in recipe it is built on (the baseline for "is this the company's"), and what the process layer itself wrote. */
interface Running {
  process: HowWeWorkView["process"];
  recipe: ResolvedRecipe;
  base: ResolvedRecipe;
  overlay: RecipeOverlay | undefined;
}

async function runningProcess(deps: HowWeWorkDependencies, orgId: OrgId, name: string, playbook: { defaultProcess: { kind: "builtin" } | { kind: "project_process"; agentId: AgentId } }): Promise<Running> {
  const pinned = deps.store === undefined ? builtinDefaultPin(ROVARA_CODE_AGENT_ID) : await deps.store.pinnedBuiltinVersion(orgId, ROVARA_CODE_AGENT_ID);
  const base = deps.store === undefined ? builtinRecipe(ROVARA_CODE_AGENT_ID, pinned) : deps.store.builtinRecipe(ROVARA_CODE_AGENT_ID, pinned);
  if (playbook.defaultProcess.kind === "builtin") {
    // A layer saved but never published is not the default yet; the page needs to find its draft. Read-only: the view never creates a layer.
    const draftLayer = deps.store === undefined ? undefined : await existingLayer({ ...deps, store: deps.store }, deps.store, orgId, name);
    // A published, active layer's version is named too (final review I3): the page says the project does not run it and offers it. An archived one can't be chosen.
    const saved = draftLayer?.status === "active" ? draftLayer.currentVersion : undefined;
    const layer = draftLayer === undefined ? undefined : { agentId: draftLayer.agentId, draftRevision: draftLayer.draftRevision, ...(saved === undefined ? {} : { currentVersion: saved }) };
    return { process: { kind: "builtin", agentId: ROVARA_CODE_AGENT_ID, ...(layer === undefined ? {} : { draftLayer: layer }) }, recipe: base, base, overlay: undefined };
  }
  const { agentId } = playbook.defaultProcess;
  const version = await requireProcessLayer(deps.store, orgId, name, agentId);
  const store = deps.store!;
  const recipe = await resolveAgent(store, orgId, agentId, version);
  const published = await store.getVersion(orgId, agentId, version);
  const draft = await store.getDraft(orgId, agentId);
  const update = await processUpdate(store, orgId, agentId, version);
  return { process: { kind: "project_process", agentId, version, ...(draft === undefined ? {} : { draftRevision: draft.revision }), ...(update === undefined ? {} : { update }) }, recipe, base, overlay: published?.overlay };
}

interface Inputs {
  running: Running;
  guardrails: AgentGuardrails;
  definition: StoredProjectDefinition | undefined;
  codeSettings: CodeSettings;
}

const commandLabel = (command: { executable: string; args: string[] }): string => clip(fit(`${command.executable} ${command.args.join(" ")}`.trim()), 80);

type StepSettings = { model?: { provider: string; modelId: string; thinkingLevel?: string } | null; thinkingLevel?: string | null; tools?: string[]; differentCompanyFrom?: string | null; instructions?: InstructionLayer[] };

/** Who a layer of instructions is from, by the chain entry of the agent that wrote it. */
function layerSource(recipe: ResolvedRecipe, layer: InstructionLayer): HowWeWorkSource {
  const entry = recipe.chain.find((candidate) => candidate.name === layer.agentName);
  if (entry === undefined || entry.builtin) return "rovara";
  return entry.process === true ? "project" : "company";
}
const layerRows = (recipe: ResolvedRecipe, layers: readonly InstructionLayer[]): Array<Marked<string>> =>
  layers.filter((layer) => layer.text.length > 0).slice(0, HOW_WE_WORK_LAYERS_MAX).map((layer) => mark(clip(redactText(layer.text), HOW_WE_WORK_INSTRUCTION_MAX), layerSource(recipe, layer)));

/** The kinds whose tools are read-only by design, and the kinds that may not change the repository at all. */
const READ_ONLY_KINDS = new Set<string>(["plan", "plan_critic", "review"]);
const CANNOT_WRITE_KINDS = new Set<string>(["plan", "plan_critic", "review", "agent", "approval"]);

function stageOf(step: ResolvedStep, inputs: Inputs): HowWeWorkStage {
  const { running, guardrails, definition, codeSettings } = inputs;
  const { recipe, base, overlay } = running;
  const settings = step.settings as StepSettings;
  const baseSettings = base.steps.find((candidate) => candidate.id === step.id)?.settings as StepSettings | undefined;
  /** The project's when its process layer set the field; the company's when a layer between set it; otherwise Rovara's. */
  const origin = (field: keyof StepSettings): HowWeWorkSource => {
    const written = (overlay?.steps?.[step.id] as StepSettings | undefined)?.[field];
    if (written !== undefined) return "project";
    return sameJson(settings[field], baseSettings?.[field]) ? "rovara" : "company";
  };

  // Who
  // V3: no model is decided here. The stage models (what runs, why, and what can be chosen) come from the model resolver's own read (`GET /v1/app/projects/{p}/stage-models`); these two rows
  // stay in the view's shape for older readers and always say "not decided here".
  const model = mark<string | null>(null, "rovara");
  const thinking = mark<string | null>(null, "rovara");
  const targets = crossCompanyTargets(recipe, step, guardrails);
  const requiredByCompany = guardrails.requireCrossCompanyReview && step.kind === "review" && recipe.steps.some((other) => other.kind === "build");
  const differentCompanyFrom = requiredByCompany ? mark(targets, "company", "company")
    : targets.length > 0 ? mark(targets, origin("differentCompanyFrom")) : mark<string[]>([], "rovara");

  // Knows
  const reviewing = isReviewingStage(step);
  const instructions = layerRows(recipe, [...wholeAgentLayers(recipe, step), ...(settings.instructions ?? [])]);

  // May
  const tools = READ_ONLY_KINDS.has(step.kind)
    ? mark<string[] | null>([...(settings.tools ?? READ_ONLY_TOOLS)].slice(0, HOW_WE_WORK_TOOLS_MAX).map((tool) => clip(tool, HOW_WE_WORK_TOOL_MAX)), settings.tools === undefined ? "rovara" : origin("tools"), "rovara")
    : mark<string[] | null>(settings.tools === undefined ? null : settings.tools.slice(0, HOW_WE_WORK_TOOLS_MAX).map((tool) => clip(tool, HOW_WE_WORK_TOOL_MAX)), settings.tools === undefined ? "rovara" : origin("tools"));

  const checked: Array<Marked<string>> = [];
  const evidence: Array<Marked<string>> = [];
  const approves: Array<Marked<string>> = [];

  if (step.kind === "check") {
    for (const command of definition?.readiness ?? []) checked.push(project(`Required: ${commandLabel(command)}`));
    if (definition !== undefined) for (const optional of developerTaskPolicy(definition).optionalWorkflowChecks ?? []) checked.push(project(`Optional: ${line(optional.label)}`));
    const capture = definition?.e2e?.capture;
    if (capture !== undefined) {
      for (const [name, on] of [["Screenshots", capture.screenshots], ["Traces", capture.traces], ["Video", capture.video], ["Downloads", capture.downloads]] as const) evidence.push(project(`${name}: ${on ? "on" : "off"}`));
    }
  }
  if (step.kind === "review") {
    for (const reviewer of step.reviewers) checked.push(rovara(reviewer === "code" ? "Code review" : "Security review"));
    if (step.onFindings !== undefined) {
      const back = recipe.steps.find((candidate) => candidate.id === step.onFindings?.backTo);
      const rounds = step.onFindings.maxRounds;
      checked.push(rovara(`Findings go back to ${line(back?.name ?? step.onFindings.backTo)}, up to ${String(rounds)} ${rounds === 1 ? "round" : "rounds"}`));
    }
  }
  if (step.kind === "plan") approves.push(rovara("A person approves the plan before any code is written", "rovara"));
  if (step.kind === "pull_request") {
    for (const section of ["Plan summary", "What changed", "Tests", "Reviews", "Risk"]) evidence.push(rovara(section));
    approves.push(rovara("Rovara never merges on its own: a person merges the pull request", "rovara"));
    // The code settings are the project's once it has saved them (a saved item has a revision); until then these are Rovara's defaults.
    const own = (text: string): Marked<string> => (codeSettings.revision > 0 ? project(text) : rovara(text));
    approves.push(own(`Self-approval: ${codeSettings.allowSelfApproval ? "allowed" : "not allowed"}`));
    approves.push(own(`Merge method: ${codeSettings.mergeMethod}`));
    if (codeSettings.codeReviewers.length > 0) approves.push(own(`Reviewers asked: ${codeSettings.codeReviewers.join(", ")}`));
  }

  return {
    id: step.id,
    name: line(step.name),
    kind: step.kind,
    who: { model, thinking, differentCompanyFrom },
    knows: { instructions, ...(reviewing ? { note: HOW_WE_WORK_REVIEWER_NOTE } : {}) },
    may: { tools, readOnly: CANNOT_WRITE_KINDS.has(step.kind) },
    checked: { items: checked.slice(0, HOW_WE_WORK_ITEMS_MAX) },
    evidence: { items: evidence.slice(0, HOW_WE_WORK_ITEMS_MAX) },
    approves: { items: approves.slice(0, HOW_WE_WORK_ITEMS_MAX) },
  };
}

/**
 * The project's process as the How we work tab shows it. Read-only: nothing is written (the built-in's pin is read with `pinnedBuiltinVersion`, which writes nothing). A playbook that points at a
 * process layer that no longer holds is `PROCESS_UNAVAILABLE`, as it is for work, never the built-in shown in its place.
 */
export async function computeHowWeWork(deps: HowWeWorkDependencies, orgId: OrgId, name: string): Promise<HowWeWorkView> {
  const playbook = await readProjectPlaybook(deps, orgId, name);
  const running = await runningProcess(deps, orgId, name, playbook);
  const [guardrails, revision, codeSettings] = await Promise.all([readGuardrails(deps, orgId), latestRevision(deps, orgId, name), readCodeSettings(deps, orgId, name)]);
  if (running.recipe.steps.length === 0) throw agentXError("CONFIG_INVALID", "this project's process has no stages");
  const inputs: Inputs = { running, guardrails, definition: revision?.definition, codeSettings };
  // v1.2 track record: what each checking stage has earned. A read that fails leaves the field out (no record, never a zero); the resolver's model fields are not repeated here.
  const stages = await Promise.all(running.recipe.steps.map(async (step) => {
    const stage = stageOf(step, inputs);
    const trackRecord = await readStageTrackRecord(deps, orgId, name, step.kind);
    return trackRecord === undefined ? stage : { ...stage, trackRecord };
  }));
  return {
    project: name,
    playbookRevision: playbook.revision,
    process: running.process,
    stages,
    rules: layerRows(running.recipe, running.recipe.instructions),
    modelsEditable: false,
  };
}
