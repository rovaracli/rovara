// Design review (DR-FU4): the one-time move of the old `dp` project list into stored settings. Before this release the stack parameter DesignReviewProjects (`dp`, variable DESIGN_REVIEW_PROJECTS) decided which projects ran
// design review. From this release `dp` gates nothing: the company's "allowed" and the project's own mode do (How we work). So that a project that ran design review keeps running it after the upgrade, this sweep step, for
// every project named in `dp` that exists in a company:
//   - sets the project's mode to Auto when the project has no stored design review setting (a project that has one is left alone);
//   - makes the company "allowed" if it is not (once per company, with the record that the move ran, so an admin who turns it off later is not overridden).
// It runs from the recovery sweep only while `dr` is on and `dp` names something (otherwise it reads nothing at all), walks this install's own company and then the directory page by page (progress is saved, so a run cut off
// by its time budget goes on at the next tick), and is idempotent: a project with a setting and a company with its record are skipped. Every change is audited as the system. `dp` itself is removed in the next release.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { AGENTX_NAME_PATTERN, BROKER_SETTINGS, BROKER_SETTING_VALUE, DESIGN_REVIEW_DEFAULT_SETTING, type OrgId } from "@agentx/contracts";
import { readProjectMeta } from "../developer/project-roles.js";
import { readProjectPlaybook, writeProjectPlaybook, type ProjectPlaybookWriter } from "../playbook/project-playbook-store.js";
import { recordDpMigration, dpMigrationRan, type DesignReviewCompanyDeps } from "./company.js";
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
  now(): number;
  log(entry: Record<string, unknown>): void;
}

const STATE_KEY = { pk: "DESIGN_REVIEW_DP_MIGRATION", sk: "STATE" };
const ORGS_PER_PAGE = 200;
export const DP_MIGRATION_BUDGET_MS = 10_000;

/** Moves one company's `dp` projects. Returns how many projects it moved (set to Auto), or "ran" when it already ran for this company. */
export async function migrateDesignReviewOrg(ports: DpMigrationPorts, orgId: OrgId, names: readonly string[]): Promise<number | "ran" | "failed"> {
  if (await dpMigrationRan(ports.company, orgId)) return "ran";
  let present = 0;
  for (const name of names) {
    if ((await readProjectMeta(ports.playbook, orgId, name)) === undefined) continue;
    present += 1;
    const current = await readProjectPlaybook(ports.playbook, orgId, name, { lenient: true });
    if (current.designReview !== undefined) continue;
    try {
      await writeProjectPlaybook(ports.playbook, {
        orgId, project: name, developerId: "system", expectedRevision: current.revision, defaultProcess: current.defaultProcess,
        designReview: { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "auto", highRiskApprover: { ...DESIGN_REVIEW_DEFAULT_SETTING.highRiskApprover } },
      });
    } catch (error) {
      // A lock stricter than Auto refuses the write (the lock already holds the project to something at least as strict), a lost race tries again at the next tick: nothing is half-recorded.
      ports.log({ event: "design_review.dp_migration_project_failed", error: error instanceof Error ? error.name : "unknown" });
      return "failed";
    }
  }
  // A company that has none of the projects is left alone: no record, no change.
  if (present === 0) return 0;
  const recorded = await recordDpMigration(ports.company, { orgId, projectCount: present });
  return recorded === "done" || recorded === "ran" ? present : "failed";
}

/**
 * One tick of the move. "off": `dr` is off or `dp` names nothing (nothing was read). "done": the whole walk finished for this `dp`. "partial": the budget ran out, the next tick goes on. "failed": a company could not be moved;
 * the next tick tries it again.
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
    const saved = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: STATE_KEY, ConsistentRead: true }))) as { Item?: { list?: unknown; done?: unknown; cursor?: unknown; installDone?: unknown } }).Item;
    // The walk is for this exact list: a different `dp` starts over.
    const same = saved?.list === list;
    if (same && saved.done === true) return "done";
    let cursor = same && typeof saved.cursor === "string" ? saved.cursor : undefined;
    let installDone = same && saved.installDone === true;
    let failed = false;
    const remember = async (done: boolean): Promise<void> => {
      await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...STATE_KEY, entityType: "DESIGN_REVIEW_DP_MIGRATION_STATE", list, done, installDone, ...(cursor === undefined ? {} : { cursor }) } }));
    };
    const one = async (orgId: OrgId): Promise<void> => {
      try {
        if ((await migrateDesignReviewOrg(ports, orgId, names)) === "failed") failed = true;
      } catch (error) {
        failed = true;
        ports.log({ event: "design_review.dp_migration_org_failed", error: error instanceof Error ? error.name : "unknown" });
      }
    };
    if (!installDone) {
      const install = ports.installOrg();
      if (install !== undefined) await one(install);
      installDone = true;
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
    // A company that failed is tried again at the next tick: the walk starts over (a company already moved is skipped by its record), and is not marked done.
    if (failed) { cursor = undefined; installDone = false; await remember(false); return "failed"; }
    await remember(true);
    return "done";
  } catch (error) {
    ports.log({ event: "design_review.dp_migration_failed", error: error instanceof Error ? error.name : "unknown" });
    return "failed";
  }
}
