// v1.2 learning loop, B7: the Home card (design 6.3). One card per project that has suggested rules to review, shown only to people who maintain the project now (`edit_settings`, read live
// through the project members). It reads STATE of at most 25 of the caller's projects in one bounded batch, and the project META beside it (for `createdAt`: a STATE of an earlier project
// of the same name is not this project's). Nothing is written for notifications, so there is no stream filter and no notifier change. The card holds a count, never a correction's or a rule's
// words, and the card id carries a hash of the project, not its name.
//
// Rules waiting for a person's approval are settled lazily (design 5.3). Home reads at most ONE approval per awaiting rule, for at most 5 rules in a call (STATE.pendingRules says whether a
// project has any), and only inside half of the source's time (`HOME_SOURCE_TIMEOUT_MS`, 2,000 ms), so a slow table never costs the card. What it finds goes to a settler, fire and forget,
// after the card is built; a read that has not answered in time is dropped and left to the next read. The settler (B6's `settle`) is plugged in with `setLearningHomeSettler`; without one Home
// reads no approval at all. Home never reads versions: deciding that a published version carries the rule is the settler's, on the learning routes.
import { createHash } from "node:crypto";
import {
  ApprovalIdSchema, LearningRuleSchema, LearningStateSchema, orgLearningSettingsKey, projectAllows, projectLearningKey, projectMetaKey,
  type ApprovalId, type LearningState, type OrgId,
} from "@agentx/contracts";
import { fit, quoted, registerHomeCardSource, HOME_SOURCE_TIMEOUT_MS, type HomeCardSource, type HomeDependencies, type HomeSourceCard } from "../agent-sessions/home.js";
import { batchGetItems, keyText } from "../agent-sessions/live.js";
import { getAnyApproval } from "../agents/approvals-store.js";
import { sameProject } from "./retention.js";
import { effectiveFromItem } from "./suggestions-switch.js";
import { readLearningPartition, type LearningDeps } from "./store.js";

type Item = Record<string, unknown>;

/** The most projects read for one Home call, and the most awaiting rules whose approval is read. */
export const LEARNING_HOME_PROJECTS_MAX = 25;
export const LEARNING_HOME_APPROVAL_READS_MAX = 5;

/** The approval states that end a waiting rule (`PENDING` and `EXECUTING` are still waiting). */
export const SETTLING_APPROVAL_STATUSES = ["APPROVED_DONE", "DECLINED", "EXPIRED", "APPROVED_FAILED"] as const;
export type SettlingApprovalStatus = (typeof SETTLING_APPROVAL_STATUSES)[number];

/** What Home found about one waiting rule: ids and the approval's state, nothing else. */
export interface LearningHomeSettlement {
  orgId: OrgId;
  project: string;
  projectCreatedAt: string;
  ruleId: string;
  suggestionId: string;
  approvalId: string;
  approvalStatus: SettlingApprovalStatus;
}
export type LearningHomeSettler = (settlement: LearningHomeSettlement) => Promise<unknown>;

let settler: LearningHomeSettler | undefined;

/** Plugs in (or, with `undefined`, takes out) the settler that Home hands ended approvals to. */
export function setLearningHomeSettler(next: LearningHomeSettler | undefined): void {
  settler = next;
}

const isSettling = (status: unknown): status is SettlingApprovalStatus => (SETTLING_APPROVAL_STATUSES as readonly string[]).includes(String(status));

function clamp(value: unknown): unknown {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : value;
}
function stateOf(item: Item | undefined): LearningState | undefined {
  if (item === undefined) return undefined;
  const parsed = LearningStateSchema.safeParse({ ...item, openSuggestions: clamp(item["openSuggestions"]), liveCorrections: clamp(item["liveCorrections"]), pendingRules: clamp(item["pendingRules"]) });
  return parsed.success ? parsed.data : undefined;
}

const hashOf = (orgId: string, project: string): string => `ph_${createHash("sha256").update(`${orgId}\n${project}`, "utf8").digest("hex").slice(0, 24)}`;
const logOf = (deps: HomeDependencies) => (entry: Record<string, unknown>) => (deps.log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);

interface Found { project: string; state: LearningState }

export const learningHomeSource: HomeCardSource = {
  kind: "rule_suggestion",
  async list(deps, caller): Promise<HomeSourceCard[]> {
    // The settling window is half of the source's time counted from the start of the source, so a slow batch read leaves less time for approvals, never more.
    const startedAt = Date.now();
    const members = deps.approvals?.projectMembers;
    if (members === undefined) return [];
    const { orgId } = caller;
    const maintained = (await members.projectsOf(orgId, { developerId: caller.developerId, orgRole: caller.orgRole }))
      .filter((entry) => projectAllows(entry.role, "edit_settings")).map((entry) => entry.project).sort().slice(0, LEARNING_HOME_PROJECTS_MAX);
    if (maintained.length === 0) return [];

    // The company's master switch rides in the same batch (one more key). While it is off no card is made, but waiting rules are still settled below.
    const switchKey = orgLearningSettingsKey(orgId);
    const keys = [switchKey, ...maintained.flatMap((project) => [projectLearningKey(orgId, project, "STATE"), projectMetaKey(orgId, project)])];
    const read = await batchGetItems(deps, keys);
    const switchedOff = effectiveFromItem(read.get(keyText(switchKey))).suggestions === "off";
    const found: Found[] = [];
    for (const project of maintained) {
      const meta = read.get(keyText(projectMetaKey(orgId, project)));
      const state = stateOf(read.get(keyText(projectLearningKey(orgId, project, "STATE"))));
      if (meta === undefined || state === undefined || meta["status"] === "archived") continue;
      // A STATE of an earlier project of the same name belongs to nobody now.
      if (!sameProject(state.projectCreatedAt, meta["createdAt"])) continue;
      found.push({ project, state });
    }

    const origin = deps.origin.replace(/\/+$/u, "");
    const cards: HomeSourceCard[] = found.filter(({ state }) => !switchedOff && state.openSuggestions > 0).map(({ project, state }) => {
      const n = state.openSuggestions;
      return {
        cardId: `rule_suggestion:${hashOf(orgId, project)}`, kind: "rule_suggestion", title: `Suggested rules for ${quoted(project)}`,
        reason: fit(`${String(n)} suggested ${n === 1 ? "rule" : "rules"} to review in ${quoted(project)}`, ""), at: state.lastGroupedAt ?? state.projectCreatedAt,
        buttons: [{ label: "Review", action: "open" as const, href: `${origin}/app/projects/${encodeURIComponent(project)}?tab=how-we-work`, method: "GET" as const }],
      };
    });

    if (settler !== undefined && deps.approvals !== undefined) await settleWaiting(deps, orgId, found, settler, startedAt);
    return cards;
  },
};

/** Reads the approval of each awaiting rule (once each, 5 at most, in half the source's time) and hands the ended ones to the settler without waiting for it. */
async function settleWaiting(deps: HomeDependencies, orgId: OrgId, found: readonly Found[], handOver: LearningHomeSettler, startedAt: number): Promise<void> {
  const log = logOf(deps);
  const approvals = deps.approvals!;
  const learning: LearningDeps = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now };
  const waiting: Array<{ project: string; projectCreatedAt: string; ruleId: string; suggestionId: string; approvalId: ApprovalId }> = [];
  const window = Math.max(50, Math.floor((deps.homeSourceTimeoutMs ?? HOME_SOURCE_TIMEOUT_MS) / 2)) - (Date.now() - startedAt);
  if (window <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const out = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), window); });
  let closed = false;
  const work = (async () => {
    for (const { project, state } of found) {
      if (state.pendingRules === 0 || waiting.length >= LEARNING_HOME_APPROVAL_READS_MAX) continue;
      const page = await readLearningPartition(learning, { orgId, project, projectCreatedAt: state.projectCreatedAt }, { prefix: "RULE#", maxItems: 50, maxPages: 1, pageSize: 50 });
      for (const item of page.items) {
        const rule = LearningRuleSchema.safeParse(item);
        const approvalId = ApprovalIdSchema.safeParse(rule.success ? rule.data.approvalId : undefined);
        if (!rule.success || rule.data.status !== "awaiting_approval" || !approvalId.success || waiting.length >= LEARNING_HOME_APPROVAL_READS_MAX) continue;
        waiting.push({ project, projectCreatedAt: state.projectCreatedAt, ruleId: rule.data.id, suggestionId: rule.data.suggestionId, approvalId: approvalId.data });
      }
    }
    // One read for each, all at once.
    await Promise.all(waiting.map(async (entry) => {
      const record = await getAnyApproval(approvals, orgId, entry.approvalId);
      if (closed || record === undefined || !isSettling(record.status)) return;
      const { approvalId, ...rest } = entry;
      // After the card is built, not before: the settler is not waited for, and its failure costs nothing but its own log line (the error's name only).
      void Promise.resolve().then(() => handOver({ orgId, ...rest, approvalId, approvalStatus: record.status as SettlingApprovalStatus })).catch((error: unknown) => {
        log({ event: "home.rule_settle_failed", error: error instanceof Error ? error.name : "unknown" });
      });
    }));
  })().catch((error: unknown) => { log({ event: "home.rule_settle_read_failed", error: error instanceof Error ? error.name : "unknown" }); });
  try {
    await Promise.race([work, out]);
  } finally {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
  }
}

registerHomeCardSource(learningHomeSource);
