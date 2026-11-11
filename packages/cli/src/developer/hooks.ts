// Plan 4 Task 19: event hooks from the command line. `agentx project hooks list | create | rotate | delete <project>`, each one signed-in call to the control plane's
// `/v1/app/projects/{p}/event-hooks` routes. A secret is never a command-line argument (it would sit in the shell's history): a vendor's secret is read from a file, and one that
// Rovara makes is printed once, by the call that made it.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { agentXError } from "@rovara-code/contracts";
import { appRequest, clean, list, readJsonFile, result, seg, str, type AppResult } from "./agents.js";
import type { DeveloperSessionDeps } from "./session.js";

type Body = Record<string, unknown>;

const base = (project: string) => `/v1/app/projects/${seg(project)}/event-hooks`;

/** The secret in a file, without the line end an editor adds. */
async function readSecretFile(path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw agentXError("CONFIG_INVALID", `--secret-file: could not read ${path}`);
  }
  return text.replace(/\r?\n$/u, "");
}

const hookLine = (hook: Body): string => `  ${str(hook.hookId)}  ${str(hook.source)}  ${str(hook.status)}${hook.lastDeliveryAt === undefined ? "  no delivery yet" : `  last delivery ${str(hook.lastDeliveryAt)}`}\n    ${str(hook.url)}`;

export async function hooksList(deps: DeveloperSessionDeps, env: string | undefined, project: string): Promise<AppResult> {
  const answer = await appRequest(deps, env, base(project));
  const hooks = list(answer.body.hooks);
  const text = hooks.length === 0 ? `${clean(project)} has no event hooks. Add one with agentx project hooks create ${clean(project)} --source <source> --tenant <tenant.json>.\n` : `${[`Event hooks of ${clean(project)}:`, ...hooks.map(hookLine)].join("\n")}\n`;
  return result(answer, { hooks }, text);
}

/** What the vendor is told to do with the address and the secret, and the one place a secret Rovara made is shown. */
function madeText(answer: { body: Body }, verb: string): string {
  const hook = (answer.body.hook ?? {}) as Body;
  const secret = typeof answer.body.secret === "string" ? answer.body.secret : undefined;
  const setup = (answer.body.setup ?? undefined) as { steps?: unknown; payloadTemplate?: unknown } | undefined;
  return [
    `${verb} hook ${str(hook.hookId)} for ${str(hook.source)}.`,
    `Post the vendor's events to: ${str(hook.url)}`,
    ...(secret === undefined ? ["The secret is the one you gave: it is not shown again."] : [`Its secret, shown once and not kept anywhere you can read it again: ${clean(secret)}`, "Put it in the vendor's webhook settings as that source says (a signing secret or a token header)."]),
    ...(setup === undefined ? [] : [...(Array.isArray(setup.steps) ? setup.steps : []).map((step, index) => `  ${String(index + 1)}. ${str(step)}`), ...(typeof setup.payloadTemplate === "string" ? ["Payload to paste exactly:", `  ${clean(setup.payloadTemplate)}`] : [])]),
    "",
  ].join("\n");
}

export async function hooksCreate(deps: DeveloperSessionDeps, env: string | undefined, project: string, input: { source?: string; tenantFile?: string; secretFile?: string }): Promise<AppResult> {
  if (input.source === undefined || input.source.trim() === "") throw agentXError("CONFIG_INVALID", "name the source with --source");
  // Read before anything is sent: a file that can't be read is not worth a request.
  const tenant = await readJsonFile(input.tenantFile, "--tenant", "object");
  const secret = await readSecretFile(input.secretFile);
  const answer = await appRequest(deps, env, base(project), { method: "POST", body: { requestId: randomUUID(), source: input.source, tenant, ...(secret === undefined ? {} : { secret }) } });
  return result(answer, answer.body, madeText(answer, "Made"));
}

export async function hooksRotate(deps: DeveloperSessionDeps, env: string | undefined, project: string, hookId: string, input: { secretFile?: string }): Promise<AppResult> {
  const secret = await readSecretFile(input.secretFile);
  const answer = await appRequest(deps, env, `${base(project)}/${seg(hookId)}/rotate`, { method: "POST", body: { requestId: randomUUID(), ...(secret === undefined ? {} : { secret }) } });
  const text = answer.body.replayed === true ? "That rotation was already made; its new secret was shown when it was.\n" : `${madeText(answer, "Rotated")}The old secret keeps working for 24 hours, so the vendor's setting can be changed without dropped events.\n`;
  return result(answer, answer.body, text);
}

export async function hooksDelete(deps: DeveloperSessionDeps, env: string | undefined, project: string, hookId: string): Promise<AppResult> {
  const answer = await appRequest(deps, env, `${base(project)}/${seg(hookId)}`, { method: "DELETE", body: { requestId: randomUUID() } });
  return result(answer, answer.body, `Deleted hook ${clean(hookId)}. Its address answers nothing now, and its secret is scheduled for deletion.\n`);
}
