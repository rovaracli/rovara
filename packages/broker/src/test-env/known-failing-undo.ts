// Setup and test health KF-1 (owner, 2026-11-02; must be done before `vx` is turned on): taking a mark OFF the project's known-failing list. Two ways, and both make results STRICTER (a test that was excused stops being excused),
// so neither needs a second person:
//   - UNDO: a project maintainer removes ONE mark from a live browser session. The press names the mark by everything stored with it ({name, checkId, markedBy, markedAt, epoch}); a mark that was changed or marked again since
//     the list was shown does not match and nothing is removed. Audited as the maintainer.
//   - EXPIRY: when a USABLE nightly (`nightlyBaselineUsable`: whole, on the tasks' base branch, recent or on the branch's unchanged head) shows a marked test passing, the mark is removed with no person asked. Audited as the
//     system. The baseline keeps the names of the failing and flaky tests only, so "passing" is read as: the night was whole and healthy (it ran tests, and its own step words do not say the environment broke), and the name is in
//     neither list. A night that cannot say this removes nothing.
// Every removal is one transaction that holds only while the list is at the version it was read at, and carries its audit event. Nothing a worker, a model or a repository prints is read.
import { createHash } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, type NightlyBaseline, type OrgId } from "@agentx/contracts";
import { auditOccurrence, auditProjectKnownFailingRemoved } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvent, type TransactItem } from "../audit/outbox.js";
import type { TestEnvDeps } from "../org/test-environment.js";
import { verifyResultsEnabled } from "../verification/switch.js";
import { knownFailingWrite, readKnownFailingRow, type KnownFailingMark } from "./known-failing.js";
import type { NightlyRecorded } from "./nightly.js";
import { nightlyBaselineUsable, type UsableNightlyOptions } from "./nightly-usable.js";

/** What a mark is named by in a request: all five stored facts. */
export type MarkRef = Pick<KnownFailingMark, "name" | "checkId" | "markedBy" | "markedAt" | "epoch">;
export const KNOWN_FAILING_UNDO_BROWSER_MESSAGE = "Use a live browser session to remove a known-failing mark.";

const hashOf = (parts: readonly string[]): string => createHash("sha256").update(parts.join("\n")).digest("hex");
const lineOf = (mark: Pick<KnownFailingMark, "name" | "checkId">): string => `${mark.checkId}\t${mark.name}`;
const same = (a: MarkRef, b: MarkRef): boolean => a.name === b.name && a.checkId === b.checkId && a.markedBy === b.markedBy && a.markedAt === b.markedAt && a.epoch === b.epoch;
const WRITE_ATTEMPTS = 3;

async function send(store: TestEnvDeps, items: TransactItem[]): Promise<boolean> {
  try {
    await store.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") return false;
    throw error;
  }
}

export interface UndoPorts {
  store: TestEnvDeps;
  /** Whether the caller may edit the project's settings now (a live check of their role, never a claim). */
  mayEditSettings(caller: { orgId: string; developerId: string }, project: string): Promise<boolean>;
}
export type UndoAnswer = "done" | "stale" | "not_ready";

/**
 * Removes one mark. FORBIDDEN without a live browser session or without maintainer authority over the project (read again here). "stale": no mark matches all five facts (it was undone, changed or marked again).
 * "not_ready": the list cannot be read or the write met another change; nothing was removed.
 */
export async function undoKnownFailing(ports: UndoPorts, caller: { orgId: OrgId; developerId: string; browserSession?: true | undefined }, project: string, ref: MarkRef, requestId: string): Promise<UndoAnswer> {
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", KNOWN_FAILING_UNDO_BROWSER_MESSAGE);
  if (!(await ports.mayEditSettings(caller, project))) throw agentXError("FORBIDDEN", "only a project maintainer can remove a mark");
  const orgId = caller.orgId;
  const before = await readKnownFailingRow(ports.store, orgId, project);
  if (before === undefined) return "not_ready";
  const found = before.marks.find((mark) => same(mark, ref));
  if (found === undefined) return "stale";
  const marks = before.marks.filter((mark) => mark !== found);
  const nowIso = new Date(ports.store.now()).toISOString();
  const event = await tryAuditEvent(ports.store, () => auditProjectKnownFailingRemoved({
    orgId, actor: { kind: "member", id: caller.developerId }, occurredAt: nowIso, occurrence: auditOccurrence(project, requestId, found.checkId, found.name, found.markedAt), projectName: project, removal: "undo", testCount: 1, markEpoch: found.epoch,
    testSetSha256: hashOf([lineOf(found)]), rowVersionAfter: before.version + 1, totalAfter: marks.length,
  }));
  const done = await send(ports.store, [knownFailingWrite(ports.store, orgId, project, before, marks, nowIso), ...(event === undefined ? [] : auditPending(ports.store, event))]);
  if (!done) return "not_ready";
  if (event !== undefined) await flushAuditEvents(ports.store, [event]);
  return "done";
}

/** Whether the night can say a test it does not list as failing PASSED: it ran tests that passed, and its own step words (when it has them) do not say the setup broke or that Rovara is unsure. */
export function nightShowsPassing(night: Pick<NightlyRecorded, "baseline" | "health">): boolean {
  if (night.baseline.tests.passed < 1) return false;
  const health = night.health;
  // A night without step words cannot say the setup worked, so it never expires a mark.
  if (health === undefined) return false;
  return health.class === "passed" || (health.class === "tests" && health.setupProved === true);
}

/** The marks a night shows passing: not in its failing list and not in its flaky list (a test that failed once is not shown passing). */
export function passingMarks(marks: readonly KnownFailingMark[], baseline: Pick<NightlyBaseline, "failed" | "flaky">): KnownFailingMark[] {
  const notPassing = new Set([...baseline.failed, ...baseline.flaky]);
  return marks.filter((mark) => !notPassing.has(mark.name));
}

/**
 * Removes the marks a usable, healthy nightly shows passing. Does nothing while `vx` is off. Never throws a fault into the nightly record: the caller treats a failure as "try again at the next night".
 * Returns how many marks were removed.
 */
export async function expireKnownFailing(store: TestEnvDeps, night: NightlyRecorded, options: UsableNightlyOptions = {}, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!verifyResultsEnabled(env) || !nightShowsPassing(night)) return 0;
  if (!(await nightlyBaselineUsable(store, night.orgId, night.project, night.baseline, options))) return 0;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const before = await readKnownFailingRow(store, night.orgId, night.project);
    if (before === undefined) return 0;
    const gone = passingMarks(before.marks, night.baseline);
    if (gone.length === 0) return 0;
    const remaining = before.marks.filter((mark) => !gone.includes(mark));
    const nowIso = new Date(store.now()).toISOString();
    const epochs = new Set(gone.map((mark) => mark.epoch));
    const event = await tryAuditEvent(store, () => auditProjectKnownFailingRemoved({
      orgId: night.orgId, actor: { kind: "system", id: "rovara" }, occurredAt: nowIso, occurrence: night.slotId, projectName: night.project, removal: "nightly_passing", testCount: gone.length,
      markEpoch: epochs.size === 1 ? [...epochs][0]! : 0, testSetSha256: hashOf(gone.map(lineOf).sort()), rowVersionAfter: before.version + 1, totalAfter: remaining.length,
    }));
    if (await send(store, [knownFailingWrite(store, night.orgId, night.project, before, remaining, nowIso), ...(event === undefined ? [] : auditPending(store, event))])) {
      if (event !== undefined) await flushAuditEvents(store, [event]);
      return gone.length;
    }
  }
  return 0;
}

/** The listener for `recordNightlyResult`: undefined while `vx` is off (the record path is then exactly today's). A failure is logged by name and swallowed: the marks stay, which is the excusing side, until the next night. */
export function knownFailingExpiryListener(store: TestEnvDeps, env: NodeJS.ProcessEnv = process.env): ((night: NightlyRecorded) => Promise<void>) | undefined {
  if (!verifyResultsEnabled(env)) return undefined;
  return async (night) => {
    try {
      await expireKnownFailing(store, night, {}, env);
    } catch (error) {
      console.log(JSON.stringify({ component: "broker", level: "warn", event: "test_env.known_failing_expiry_failed", orgId: night.orgId, error: error instanceof Error ? error.name : "unknown" }));
    }
  };
}
