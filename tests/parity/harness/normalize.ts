// Normalization before comparing: the known key and shape differences between Cloud's path and the core (plan 3.3, D1-D15) are mapped to one form, ids
// become their family, and anything volatile (times, random ids) is dropped. A difference that is NOT in this map shows as a difference: the map is the
// list of differences already understood, each with its row of the D table.
import { FACETS, type Observation } from "./types.js";

/** Key family of a stored row: ids replaced by `<id>`, the company scope removed where the D table says the two keep the same rows under another key. */
export function keyFamily(pk: string, sk: string): string {
  const id = (text: string): string => text
    .replace(/org_[0-9a-z]{20}/g, "<org>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/\b(ses|evt|crn|rq)_[0-9a-z]{8,}\b/g, "<$1>")
    // The person: Cloud keys a developer by a hash of the sign-in, the local core by `local-owner` (D6/D11: open provider names).
    .replace(/\b(DEVELOPER|DEVELOPER_LIMIT|IDEMPOTENCY|MY_SESSIONS)#(?:[0-9a-f]{16,64}|local-owner)\b/g, "$1#<person>")
    .replace(/#(?:[0-9a-f]{16,64}|local-owner)#/g, "#<person>#")
    .replace(/\b[0-9a-f]{16,64}\b/g, "<hash>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<time>")
    .replace(/#\d+\b/g, "#<n>");
  let p = id(pk);
  // D1: dispatch rows. Cloud: WORKFLOW_DISPATCH; core: ORG#<c>#WORKFLOW_DISPATCH. Same rows.
  if (p === "ORG#<org>#WORKFLOW_DISPATCH") p = "WORKFLOW_DISPATCH";
  // D2: outbox rows. Cloud: OUTBOX#<id> read by its stream publisher; core: ORG#<c>#OUTBOX#<id> on the outbox-pending index. Same purpose.
  if (p.startsWith("ORG#<org>#OUTBOX#")) p = p.slice("ORG#<org>#".length);
  // D4: approval records live under different keys on purpose (no clash); compared as one family.
  if (/^ORG#<org>#APPROVAL_(DECISION|PROOF)/.test(p) || p.startsWith("APPROVAL#")) p = "APPROVAL*";
  return `${p} | ${id(sk)}`;
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
const SHARED_FAMILIES = /^(DEVTASK#|WORKSPACE#|WORKFLOW_DISPATCH |IDEMPOTENCY#|DEVELOPER#|DEVELOPER_LIMIT#|ORG#<org>#DEVELOPER_LIMIT#|ORG#<org>#SLACK_LIMIT#|OUTBOX#)/;

export function sharedRows(rows: readonly string[]): string[] {
  // Cloud's notifier keeps its sent-notice marks on the task's partition (`DEVTASK#<id> | NOTICE#...`): Cloud's own notices, compared on the messages facet.
  return rows.filter((row) => SHARED_FAMILIES.test(row) && !row.startsWith("DEVTASK#<id> | NOTICE#"));
}

export function normalize(observation: Observation): Observation {
  const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();
  return {
    transitions: collapse(observation.transitions),
    decisions: [...observation.decisions],
    rows: sortedUnique(sharedRows(observation.rows)),
    messages: [...observation.messages],
    codeHost: [...observation.codeHost],
    spend: [...observation.spend],
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
