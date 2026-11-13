// Normalization before comparing: the known key and shape differences between Cloud's path and the core (plan 3.3, D1-D15) are mapped to one form, ids
// become their family, and anything volatile (times, random ids) is dropped. A difference that is NOT in this map shows as a difference: the map is the
// list of differences already understood, each with its row of the D table.
import { FACETS, type Observation } from "./types.js";

/** Key family of a stored row: ids replaced by `<id>`, the company scope removed where the D table says the two keep the same rows under another key. */
export function keyFamily(pk: string, sk: string): string {
  const id = (text: string): string => text
    .replace(/org_[0-9a-z]{20}/g, "<org>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/\b(ses|evt|crn|rq|chn|agt|ctr)_[0-9a-z]{8,}\b/g, "<$1>")
    // The person: Cloud keys a developer by a hash of the sign-in, the local core by `local-owner` (D6/D11: open provider names).
    .replace(/\b(DEVELOPER|DEVELOPER_LIMIT|IDEMPOTENCY|MY_SESSIONS|TRIGGERS_BY_CREATOR)#(?:[0-9a-f]{16,64}|local-owner)\b/g, "$1#<person>")
    .replace(/#(?:[0-9a-f]{16,64}|local-owner)#/g, "#<person>#")
    // A message a person sent to a task (the core's note row: `NOTE#msg_<random>`).
    .replace(/\bmsg_[0-9a-z]{8,}\b/g, "msg_<id>")
    .replace(/\b[0-9a-f]{16,64}\b/g, "<hash>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<time>")
    // An hour bucket (a trigger's hourly allowance row: `TRIGGER_RATE#<trigger> | 2026-11-12T10`).
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}\b/g, "<hour>")
    .replace(/#\d+\b/g, "#<n>")
    // A chain or agent event's sort key ends in a short random suffix after its sequence (`EVENT#<time>#<n>-1700e4`).
    .replace(/#<n>-[0-9a-f]{4,12}\b/g, "#<n>-<hash>");
  let p = id(pk);
  // D1: dispatch rows. Cloud: WORKFLOW_DISPATCH; core: ORG#<c>#WORKFLOW_DISPATCH. Same rows.
  if (p === "ORG#<org>#WORKFLOW_DISPATCH") p = "WORKFLOW_DISPATCH";
  // D2: outbox rows. Cloud: OUTBOX#<id> read by its stream publisher; core: ORG#<c>#OUTBOX#<id> on the outbox-pending index. Same purpose.
  if (p.startsWith("ORG#<org>#OUTBOX#")) p = p.slice("ORG#<org>#".length);
  // D4: approval records live under different keys on purpose (no clash); compared as one family.
  if (/^ORG#<org>#APPROVAL_(DECISION|PROOF)/.test(p) || p.startsWith("APPROVAL#")) p = "APPROVAL*";
  let k = id(sk);
  // D3 limits (cloud/rows/core-rows.ts CORE_LIMIT_FAMILY): a person has one limit family after the switch, the core's person family (`DEVELOPER_LIMIT#<person>`,
  // `ORG#<c>#DEVELOPER_LIMIT#ORGANIZATION`); Cloud's Slack workspace counters (`ORG#<c>#SLACK_LIMIT#<team>`: MEMBER#<slack user>, ORGANIZATION) count the same slots on Cloud's
  // path, so a counter is one family on both. The core's per-task marker (`TASK#<id>` beside the person's counter) is the shape Cloud keeps as a string set inside the counter.
  if (/^ORG#<org>#SLACK_LIMIT#[A-Z0-9]+$/.test(p)) { p = "LIMIT_COUNTER"; k = k.startsWith("MEMBER#") ? "MEMBER" : k; }
  else if (p === "DEVELOPER_LIMIT#<person>" && k === "MEMBER") p = "LIMIT_COUNTER";
  else if (p === "ORG#<org>#DEVELOPER_LIMIT#ORGANIZATION" && k === "ORGANIZATION") p = "LIMIT_COUNTER";
  else if (p === "DEVELOPER_LIMIT#<person>" && k.startsWith("TASK#")) p = "LIMIT_MARKER";
  // D17 artifacts: Cloud `ARTIFACT#<artifactId>`, core `ARTIFACT#<operationId>#<name>`; Cloud's readers read both (core-rows.ts findArtifactRow), so one family.
  if (/^ARTIFACT#<id>#.+/.test(k)) k = "ARTIFACT#<id>";
  return `${p} | ${k}`;
}

/** Audit event names to one vocabulary (Cloud's audit types and Code's actions differ by name; A7's event map is the authority once merged). */
const AUDIT_NAMES: Readonly<Record<string, string>> = {
  "task.started": "task.started",
  "developer_task.started": "task.started",
  "task.start_refused": "task.start_refused",
};

export function auditName(name: string): string {
  return AUDIT_NAMES[name] ?? name;
}

/**
 * The key families both paths are meant to share (the task records of plan 3.3: task, workspace and operations, dispatch, idempotency, the person's task
 * index, the limits, the outbox). Rows outside them are each path's own (Cloud's Slack thread and notices, the core's session projection) and are not
 * compared: comparing them would only say the two products are different products.
 */
const SHARED_FAMILIES = new RegExp([
  "^(DEVTASK#|WORKSPACE#|WORKFLOW_DISPATCH |IDEMPOTENCY#|DEVELOPER#|LIMIT_COUNTER |OUTBOX#",
  // Chains, triggers, automatic runs and custom agents (areas 16, 17): the key layout both runners are meant to share (CHAIN, CHAINS, CHAIN_NAME,
  // CHAIN_RUN, CHAIN_RUNS, CHAIN_RUNS_P, CHAIN_STEP_TASK, OPEN_CHAIN_RUNS, AGENT, AGENT_DIRECTORY, AGENT_NAME), plus each runner's own rows next to
  // them (Cloud's BUILTIN_AGENTS, the core's UNATTENDED_RUN_OPEN), so a row only one writes shows. A chain run's agent session (Cloud's
  // AGENT_SESSION#<crn>) stays with the session families, which no scenario compares yet (a Slack-started Cloud task has none).
  "|ORG#<org>#CHAIN|OPEN_CHAIN_RUNS |ORG#<org>#AGENT#|ORG#<org>#AGENT_DIRECTORY|ORG#<org>#AGENT_NAME|ORG#<org>#BUILTIN_AGENTS |ORG#<org>#UNATTENDED_RUN_OPEN |ORG#<org>#TRIGGER",
  ")",
].join(""));

export function sharedRows(rows: readonly string[]): string[] {
  // Cloud's notifier keeps its sent-notice marks on the task's partition (`DEVTASK#<id> | NOTICE#...`): Cloud's own notices, compared on the messages facet.
  // Rows one product keeps under a name of its own, each with its D-table row (core-rows.ts): the operation's events (D18: `OPERATION#<op>/EVENT#<n>` on Cloud, not compared, and
  // `WORKSPACE#<w>/EVENT#<op>#<n>` on the core: both are read by Cloud's readers, and how many there are depends on how often a worker flushes), the core's cache of the changed files
  // it read from the code host (D19: no Cloud reader asks for it), and the core's limit markers (D3: Cloud keeps the same fact as a set inside the counter).
  const ownRows = /^(WORKSPACE#<id> \| (EVENT#|VERIFIED_FILES#)|LIMIT_MARKER \|)/;
  return rows.filter((row) => SHARED_FAMILIES.test(row) && !row.startsWith("DEVTASK#<id> | NOTICE#") && !ownRows.test(row));
}

export function normalize(observation: Observation): Observation {
  const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();
  return {
    transitions: collapse(observation.transitions),
    decisions: [...observation.decisions],
    rows: sortedUnique(sharedRows(observation.rows)),
    messages: kindCounts(observation.messages),
    codeHost: [...observation.codeHost],
    spend: [...observation.spend],
    features: [...observation.features],
    audit: sortedUnique(observation.audit.map(auditName)),
  };
}

/**
 * Repeated states collapse to one (an engine that polls more often sees the same state twice), and `<stage>/READY` is dropped: it is the core's "the step is
 * queued for dispatch" state, which Cloud's path writes in the same commit as RUNNING. A step that stays READY (never dispatched) still shows: the next state differs.
 */
function collapse(states: readonly string[]): string[] {
  const kept = states.filter((state) => !state.endsWith("/READY"));
  return kept.filter((state, index) => index === 0 || state !== kept[index - 1]);
}

export const EMPTY_OBSERVATION: Observation = Object.fromEntries(FACETS.map((facet) => [facet, []])) as unknown as Observation;

/**
 * Messages compare as `kind=count`, sorted (engines/facets-support/messages.ts): what the person was told and how often, not in which order or batch, nor
 * with which words. A difference in a count shows as two differing values (`needs_you=2` against `needs_you=1`), so a wildcard entry never hides it.
 */
export function kindCounts(kinds: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => `${kind}=${String(count)}`).sort();
}
