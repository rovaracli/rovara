// Design review (DR-FU4): the one-time move of the old `dp` project list into stored settings. Before this release the stack parameter DesignReviewProjects (`dp`, variable DESIGN_REVIEW_PROJECTS) decided which projects ran
// design review. From this release `dp` gates nothing: the company's "allowed" and the project's own mode do (How we work). So that a project that ran design review keeps running it after the upgrade, this sweep step
// moves each `dp` project into stored settings: the project's mode becomes Auto if it has no stored setting (held to the company's lock), and the company becomes "allowed" once, with a record that the move ran.
//
// WHICH COMPANIES. A project name is unique only inside one company, so a bare name match must never turn design review on for a company: only a company the operator demonstrably meant qualifies.
//   - An install that has its own company (single-tenant: `installOrg()`): ONLY that company. `dp` was that operator's setting for that company.
//   - Otherwise (several companies): only a company where the project has at least one task that already carries a `designReview` record, which is proof that `dp` was in use for it. The directory is walked page by page.
//   - Any other company with a project of that name is left untouched, and one log line names the project (`design_review.dp_migration_not_enabled`), so the upgrade report can tell the operator to turn it on in How we work.
//
// It runs from the recovery sweep AFTER the dispatch work, in a small budget, only while `dr` is on and `dp` names something (otherwise it reads nothing at all). It is idempotent: a project with a setting and a company with its
// record are skipped. A company where the move is REFUSED (the lock cannot take the write) is recorded as skipped once and never retried; one that fails for a transient reason is retried at the next tick (kept in the
// state item). Every change is audited as the system. `dp` itself is removed in 0.5.6.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { AGENTX_NAME_PATTERN, BROKER_SETTINGS, BROKER_SETTING_VALUE, DESIGN_REVIEW_DEFAULT_SETTING, type OrgId } from "@agentx/contracts";
import { readProjectMeta } from "../developer/project-roles.js";
import { readProjectPlaybook, writeProjectPlaybook, type ProjectPlaybookWriter } from "../playbook/project-playbook-store.js";
import { recordDpMigration, dpMigrationRan, type DesignReviewCompanyDeps } from "./company.js";
import { applyLock, readDesignReviewLock } from "./lock.js";
import { designReviewEnabled } from "./switch.js";

/** The project names `dp` lists. A value that is not plain text, or a name that is not a project name, makes the whole list empty (fail closed: nothing is moved). */
export function legacyDesignReviewProjects(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = env[BROKER_SETTINGS.designReviewProjects.variable];
  if (raw === undefined || raw === "" || !BROKER_SETTING_VALUE.test(raw)) return [];
  const names = raw.split(":");
  return names.every((name) => AGENTX_NAME_PATTERN.test(name)) ? [...new Set(names)] : [];
}

export interface DpMigrationPorts {
  playbook: ProjectPlaybookWriter;
  company: DesignReviewCompanyDeps;
  /** The orgs in id order after `after`, at most `limit` (the model-sources directory in production). */
  listOrgs(after: string | undefined, limit: number): Promise<OrgId[]>;
  /** This install's own company, when it has one (a multi-tenant install names none). */
  installOrg(): OrgId | undefined;
  /** Whether the project has at least one task in this company that already carries a design review: the proof that `dp` was in use for it. */
  projectHadDesignReview(orgId: OrgId, project: string): Promise<boolean>;
  now(): number;
  log(entry: Record<string, unknown>): void;
}

const STATE_KEY = { pk: "DESIGN_REVIEW_DP_MIGRATION", sk: "STATE" };
const ORGS_PER_PAGE = 200;
const RETRY_MAX = 100;
export const DP_MIGRATION_BUDGET_MS = 2_000;

export type MigrateOrgResult = number | "ran" | "skipped" | "failed";
const refused = (error: unknown): boolean => error instanceof Error && (error as { code?: unknown }).code === "CONFIG_INVALID";

/**
 * Moves one company's `dp` projects. `evidence` says why this company qualifies: `install` (it is the install's own company) or `tasks` (a project of it has a task with a design review). Returns how many projects it moved
 * (counted when the project now has a stored setting), "ran" when the move already ran for this company, "skipped" when a write was refused (recorded, never retried), or "failed" for a transient fault (retried).
 */
export async function migrateDesignReviewOrg(ports: DpMigrationPorts, orgId: OrgId, names: readonly string[], evidence: "install" | "tasks" = "install"): Promise<MigrateOrgResult> {
  if (await dpMigrationRan(ports.company, orgId)) return "ran";
  const lock = await readDesignReviewLock(ports.company, orgId);
  let qualified = 0, refusedCount = 0;
  for (const name of names) {
    if ((await readProjectMeta(ports.playbook, orgId, name)) === undefined) {
      // The install's own company is the only one `dp` meant, so a name it does not have is worth a line (a company among many simply lacks most names).
      if (evidence === "install") ports.log({ event: "design_review.dp_migration_not_enabled", project: name, reason: "no_such_project" });
      continue;
    }
    if (evidence === "tasks" && !(await ports.projectHadDesignReview(orgId, name))) {
      // A bare name match is no evidence: nothing is set for this company, and the log names the project.
      ports.log({ event: "design_review.dp_migration_not_enabled", project: name, reason: "no_design_review_task" });
      continue;
    }
    const current = await readProjectPlaybook(ports.playbook, orgId, name, { lenient: true });
    if (current.designReview !== undefined) { qualified += 1; continue; }
    // A project with no setting is Off, so the move gives it its own: Auto, held to the company's lock first so a lock that forbids Auto's defaults does not refuse the move.
    const wanted = { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "auto" as const, highRiskApprover: { ...DESIGN_REVIEW_DEFAULT_SETTING.highRiskApprover } };
    const setting = lock.kind === "lock" ? applyLock(wanted, lock.lock) : wanted;
    try {
      await writeProjectPlaybook(ports.playbook, {
        orgId, project: name, developerId: "system", expectedRevision: current.revision, defaultProcess: current.defaultProcess, designReview: setting, skipProcessEvent: true,
      });
      qualified += 1;
    } catch (error) {
      if (!refused(error)) { ports.log({ event: "design_review.dp_migration_project_failed", project: name, error: error instanceof Error ? error.name : "unknown" }); return "failed"; }
      // Refused (an unreadable lock, a group the edition lacks): only this project is skipped, and the log names it so the operator can turn it on in How we work. The others of the list are still moved.
      ports.log({ event: "design_review.dp_migration_not_enabled", project: name, reason: "refused" });
      refusedCount += 1;
    }
  }
  if (qualified === 0) {
    // Every project that qualified was refused: the refusal is recorded once and never retried. Otherwise nothing qualified: no record, no change, and the install's own company says so.
    if (refusedCount > 0) { await recordDpMigration(ports.company, { orgId, projectCount: 0, allow: false, reason: "refused" }); return "skipped"; }
    if (evidence === "install") ports.log({ event: "design_review.dp_migration_nothing_qualified", projectCount: names.length });
    return 0;
  }
  // At least one project holds a stored setting: the company is allowed so that it keeps running (an admin's own earlier choice stands).
  const recorded = await recordDpMigration(ports.company, { orgId, projectCount: qualified, allow: true });
  return recorded === "done" || recorded === "kept" || recorded === "ran" ? qualified : "failed";
}

interface State { list?: unknown; done?: unknown; cursor?: unknown; installDone?: unknown; retry?: unknown }
const retryOf = (state: State | undefined): string[] => (Array.isArray(state?.retry) ? state.retry.filter((entry): entry is string => typeof entry === "string").slice(0, RETRY_MAX) : []);

/**
 * One tick of the move. "off": `dr` is off or `dp` names nothing (nothing was read). "done": the whole walk finished for this `dp`. "partial": the budget ran out, the next tick goes on. "failed": a company failed for a
 * transient reason; it is kept and tried again at the next tick (and only it).
 */
export async function runDesignReviewDpMigration(ports: DpMigrationPorts, env: NodeJS.ProcessEnv = process.env, options: { budgetMs?: number; pageSize?: number; clock?: () => number } = {}): Promise<"off" | "done" | "partial" | "failed"> {
  if (!designReviewEnabled(env)) return "off";
  const names = legacyDesignReviewProjects(env);
  if (names.length === 0) return "off";
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const budget = options.budgetMs ?? DP_MIGRATION_BUDGET_MS;
  const pageSize = options.pageSize ?? ORGS_PER_PAGE;
  const list = names.join(":");
  const table = ports.playbook;
  try {
    const saved = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: STATE_KEY, ConsistentRead: true }))) as { Item?: State }).Item;
    // The walk is for this exact list: a different `dp` starts over.
    const same = saved?.list === list;
    if (same && saved.done === true) return "done";
    let cursor = same && typeof saved.cursor === "string" ? saved.cursor : undefined;
    let installDone = same && saved.installDone === true;
    const retry = new Set(same ? retryOf(saved) : []);
    const remember = async (done: boolean): Promise<void> => {
      await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...STATE_KEY, entityType: "DESIGN_REVIEW_DP_MIGRATION_STATE", list, done, installDone, ...(cursor === undefined ? {} : { cursor }), ...(retry.size === 0 ? {} : { retry: [...retry].slice(0, RETRY_MAX) }) } }));
    };
    const install = ports.installOrg();
    const one = async (orgId: OrgId): Promise<void> => {
      try {
        const result = await migrateDesignReviewOrg(ports, orgId, names, install !== undefined && orgId === install ? "install" : "tasks");
        if (result === "failed") retry.add(orgId); else retry.delete(orgId);
      } catch (error) {
        retry.add(orgId);
        ports.log({ event: "design_review.dp_migration_org_failed", error: error instanceof Error ? error.name : "unknown" });
      }
    };
    // A company that failed earlier is tried again first, and only it.
    for (const orgId of [...retry]) {
      if (clock() - startedAt >= budget) { await remember(false); return "partial"; }
      await one(orgId);
    }
    if (install !== undefined) {
      // A single-tenant install: its own company is the only one `dp` meant. No directory walk, so no other company is ever touched by a name match.
      if (!installDone) { await one(install); installDone = true; }
      cursor = undefined;
      await remember(retry.size === 0);
      return retry.size === 0 ? "done" : "failed";
    }
    for (;;) {
      const page = await ports.listOrgs(cursor, pageSize);
      for (const orgId of page) {
        if (clock() - startedAt >= budget) { await remember(false); return "partial"; }
        await one(orgId);
        cursor = orgId;
      }
      if (page.length < pageSize) break;
      await remember(false);
    }
    await remember(retry.size === 0);
    return retry.size === 0 ? "done" : "failed";
  } catch (error) {
    ports.log({ event: "design_review.dp_migration_failed", error: error instanceof Error ? error.name : "unknown" });
    return "failed";
  }
}
