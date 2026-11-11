// Plan 4 Task 4: chains from the command line. `agentx chains list | show | create | draft get | draft set | publish | versions | rollback | archive |
// unarchive | share`, each one or two signed-in calls to the control plane's /v1/app/chains routes. The control plane decides who may do what; a refusal is
// printed as the broker wrote it (a revision conflict exits 1). A change that waits for a person prints the confirmation page's link; nothing here
// decides an approval (R66).
import { randomUUID } from "node:crypto";
import { agentXError } from "@rovara-code/contracts";
import { appRequest, clean, developerRef, list, positive, pretty, readJsonFile, result, seg, str, waitingText, type AppResult } from "./agents.js";
import type { DeveloperSessionDeps } from "./session.js";

type Body = Record<string, unknown>;

const problemLines = (problems: unknown): string[] => list(problems).map((problem) => `  ${str(problem.path)}: ${str(problem.message)}`);

const chainLine = (chain: Body): string => {
  const version = chain.currentVersion === undefined ? "unpublished" : `v${str(chain.currentVersion)}`;
  return `  ${str(chain.chainId)}  ${str(chain.name)}  ${version}  ${str(chain.access)}${chain.status === "archived" ? "  (archived)" : ""}`;
};

export async function chainsList(deps: DeveloperSessionDeps, env: string | undefined, filter: { scope?: "mine" | "shared"; project?: string }): Promise<AppResult> {
  const query = filter.project !== undefined ? `?project=${seg(filter.project)}` : `?scope=${filter.scope ?? "all"}`;
  const answer = await appRequest(deps, env, `/v1/app/chains${query}`);
  const chains = list(answer.body.chains);
  const text = chains.length === 0 ? `No chains here on ${answer.env}. Create one with agentx chains create --name <name>.\n` : `${[`Chains on ${answer.env} (${answer.url}):`, ...chains.map(chainLine)].join("\n")}\n`;
  return result(answer, { chains }, text);
}

function stepLine(step: Body): string {
  if (step.kind === "gate") return `    ${str(step.id)}  gate: ${str(step.prompt)}`;
  const agent = (step.agent ?? {}) as Body;
  return `    ${str(step.id)}  ${str(agent.agentId)} v${str(agent.version)}`;
}

export async function chainsShow(deps: DeveloperSessionDeps, env: string | undefined, chainId: string): Promise<AppResult> {
  const answer = await appRequest(deps, env, `/v1/app/chains/${seg(chainId)}`);
  const chain = (answer.body.chain ?? {}) as Body;
  const current = answer.body.current as Body | undefined;
  const steps = current === undefined ? [] : list((current.definition as Body | undefined)?.steps);
  const lines = [
    `${str(chain.name)} (${str(chain.chainId)})`,
    ...(str(chain.description) === "" ? [] : [`  ${str(chain.description)}`]),
    `  your access: ${str(chain.access)}; status: ${str(chain.status)}`,
    current === undefined ? "  not published yet" : `  runs version ${str(current.version)}`,
    ...(chain.monthlyBudgetUsd === undefined ? [] : [`  monthly budget: $${str(chain.monthlyBudgetUsd)}`]),
    ...(steps.length === 0 ? [] : ["  steps:", ...steps.map(stepLine)]),
  ];
  return result(answer, answer.body, `${lines.join("\n")}\n`);
}

export async function chainsCreate(
  deps: DeveloperSessionDeps, env: string | undefined,
  input: { name?: string; description?: string; file?: string; projectOwner?: string; accountable?: string },
): Promise<AppResult> {
  if (input.name === undefined || input.name.trim() === "") throw agentXError("CONFIG_INVALID", "name the chain with --name");
  if (input.accountable !== undefined && input.projectOwner === undefined) throw agentXError("CONFIG_INVALID", "--accountable names who answers for a project's chain; give the project with --project-owner");
  // Read before anything is sent: a design that can't be read is not worth a request.
  const definition = input.file === undefined ? undefined : await readJsonFile(input.file, "--file", "object");
  const accountable = input.accountable === undefined ? undefined : await developerRef(deps, env, input.accountable);
  const answer = await appRequest(deps, env, "/v1/app/chains", {
    method: "POST",
    body: {
      requestId: randomUUID(), name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.projectOwner === undefined ? {} : { owner: { kind: "project", project: input.projectOwner } }),
      ...(accountable === undefined ? {} : { accountable: { developerId: accountable.developerId } }),
      ...(definition === undefined ? {} : { definition }),
    },
  });
  const chain = (answer.body.chain ?? {}) as Body;
  return result(answer, answer.body, `Created ${str(chain.name)} (${str(chain.chainId)}). Edit its draft with agentx chains draft set ${str(chain.chainId)} --file <definition.json>, then publish it.\n`);
}

async function draftOf(deps: DeveloperSessionDeps, env: string | undefined, chainId: string) {
  const answer = await appRequest(deps, env, `/v1/app/chains/${seg(chainId)}/draft`);
  const draft = (answer.body.draft ?? {}) as Body;
  if (typeof draft.revision !== "number") throw agentXError("RUNTIME_UNAVAILABLE", "AgentX answered with a draft that has no revision; try again");
  return { answer, draft, revision: draft.revision };
}

export async function chainsDraftGet(deps: DeveloperSessionDeps, env: string | undefined, chainId: string): Promise<AppResult> {
  const { answer, draft } = await draftOf(deps, env, chainId);
  const problems = problemLines(answer.body.problems);
  const text = `Draft of ${clean(chainId)} at revision ${str(draft.revision)}:\n${pretty(draft.definition ?? {})}\n${problems.length === 0 ? "" : `Problems to fix before it can be published:\n${problems.join("\n")}\n`}`;
  return result(answer, { draft, problems: list(answer.body.problems) }, text);
}

/** Saves a design as the draft, at the revision read just before, so someone else's edit since is a conflict, not lost. */
export async function chainsDraftSet(deps: DeveloperSessionDeps, env: string | undefined, chainId: string, file: string | undefined): Promise<AppResult> {
  const definition = await readJsonFile(file, "--file", "object");
  const { revision } = await draftOf(deps, env, chainId);
  const answer = await appRequest(deps, env, `/v1/app/chains/${seg(chainId)}/draft`, { method: "PUT", body: { requestId: randomUUID(), expectedRevision: revision, definition } });
  const draft = (answer.body.draft ?? {}) as Body;
  return result(answer, answer.body, `Saved the draft of ${clean(chainId)}; it is at revision ${str(draft.revision)}. Publish it with agentx chains publish ${clean(chainId)}.\n`);
}

export async function chainsPublish(deps: DeveloperSessionDeps, env: string | undefined, chainId: string, note: string | undefined): Promise<AppResult> {
  const { revision } = await draftOf(deps, env, chainId);
  const answer = await appRequest(deps, env, `/v1/app/chains/${seg(chainId)}/publish`, { method: "POST", body: { requestId: randomUUID(), expectedDraftRevision: revision, ...(note === undefined ? {} : { note }) } });
  const waiting = waitingText(answer.body);
  if (waiting !== undefined) return result(answer, answer.body, waiting);
  const version = (answer.body.version ?? {}) as Body;
  const off = list(answer.body.disabledTriggers).flatMap((trigger) => [`  ${str(trigger.triggerId)} was turned off:`, ...problemLines(trigger.problems).map((line) => `  ${line}`)]);
  return result(answer, answer.body, `${[`Published ${clean(chainId)} as version ${str(version.version)}; new runs use it.`, ...(off.length === 0 ? [] : ["Triggers that no longer qualify:", ...off])].join("\n")}\n`);
}

export async function chainsVersions(deps: DeveloperSessionDeps, env: string | undefined, chainId: string): Promise<AppResult> {
  const answer = await appRequest(deps, env, `/v1/app/chains/${seg(chainId)}/versions`);
  const versions = list(answer.body.versions);
  const lines = versions.map((version) => `  v${str(version.version)}${version.current === true ? " (runs now)" : ""}  ${str(version.publishedAt)}${version.note === undefined ? "" : `  ${str(version.note)}`}`);
  return result(answer, { versions }, `${[`Versions of ${clean(chainId)}:`, ...lines].join("\n")}\n`);
}

export async function chainsRollback(deps: DeveloperSessionDeps, env: string | undefined, chainId: string, version: string): Promise<AppResult> {
  const body = { requestId: randomUUID(), version: positive(version, "the version") };
  const answer = await appRequest(deps, env, `/v1/app/chains/${seg(chainId)}/rollback`, { method: "POST", body });
  const off = list(answer.body.disabledTriggers).map((trigger) => `  ${str(trigger.triggerId)} was turned off`);
  return result(answer, answer.body, waitingText(answer.body) ?? `${clean(chainId)} runs version ${body.version} again.\n${off.length === 0 ? "" : `${off.join("\n")}\n`}`);
}

export async function chainsArchive(deps: DeveloperSessionDeps, env: string | undefined, chainId: string, archive: boolean): Promise<AppResult> {
  const answer = await appRequest(deps, env, `/v1/app/chains/${seg(chainId)}/${archive ? "archive" : "unarchive"}`, { method: "POST", body: { requestId: randomUUID() } });
  return result(answer, answer.body, archive ? `Archived ${clean(chainId)}; it no longer starts runs. Bring it back with agentx chains unarchive ${clean(chainId)}.\n` : `${clean(chainId)} is active again.\n`);
}

export async function chainsShare(deps: DeveloperSessionDeps, env: string | undefined, chainId: string, file: string | undefined): Promise<AppResult> {
  const shares = await readJsonFile(file, "--file", "array");
  const answer = await appRequest(deps, env, `/v1/app/chains/${seg(chainId)}/shares`, { method: "PUT", body: { requestId: randomUUID(), shares } });
  const count = list(answer.body.shares).length;
  return result(answer, answer.body, waitingText(answer.body) ?? `${clean(chainId)} is now shared with ${count} ${count === 1 ? "principal" : "principals"}.\n`);
}
