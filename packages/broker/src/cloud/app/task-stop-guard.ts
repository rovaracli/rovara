// Switch blocker 2 (money): the switch must not change money behaviour. Cloud's own start captures the task's spending stop (the company's per-task stop policy and the funding-sources pin,
// `captureTaskStopAdmission`, stored on the task and on its operations) for a company that is ENROLLED in per-task stops; for a company that never enrolled it captures nothing (`disabled`).
// The core's start has no place to carry that snapshot: Code's task record and operations are written by Code, and `startExtras` adds items beside them, not fields to them. So:
//   - a company not enrolled: nothing to capture on either engine, and the core's start is the same in money terms (its payer rules and its admission levels are Cloud's, money.ts);
//   - a company enrolled: a NEW task of theirs starts on Cloud's path, exactly as before, until the core can carry the stop. The start hook and the Slack consumer ask this and decline.
// "Enrolled" here means "stays on Cloud's path", and it reads the company's rows EXACTLY as `captureTaskStopAdmission` does (org/task-stop-admission.ts, the snapshot's reads and checks), failing closed:
//   - no policy row and no seed receipt: never enrolled, so the core may start;
//   - a policy row of the right shape whose enrollment state is `disabled` or `ready` (every company the bootstrap seeded has one, with a seed receipt): not enrolled, so the core may start;
//   - state `enabled`, a policy row Cloud's capture would refuse (a malformed row, a ceiling field it forbids, an unknown state), a receipt it would refuse, or a receipt with no policy row: Cloud's
//     capture does not read these as "disabled", so the start stays on Cloud's path, where it fails or captures as it does today.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { orgScoped, when, type OrgId, type TransactItem } from "@rovara-code/contracts";
import { orgMetaKey, orgSettingsKey } from "@agentx/cloud-contracts";

const positiveRevision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const FORBIDDEN_CEILING_FIELDS = ["ceilingMicrousd", "maxPerRunCeilingUsd", "taskStopCeilingMicrousd"];

const receiptOk = (item: Record<string, unknown>, source: "bootstrap" | "upgrade"): boolean =>
  item["entityType"] === "TASK_STOP_SEED" && item["version"] === 1 && item["source"] === source && ["created", "preserved"].includes(String(item["outcome"])) && positiveRevision(item["policyRevision"]);

/** What a start read of the company's spending-stop rows: whether it stays on Cloud's path, and the checks that hold the core start to what was read (the policy still absent, or still at its revision). */
export interface TaskStopRead { enrolled: boolean; fence: Array<Extract<TransactItem, { kind: "check" }>> }

export async function readTaskStop(deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }, orgId: OrgId): Promise<TaskStopRead> {
  const read = async (Key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> =>
    ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  const policyKey = orgSettingsKey(orgId, "TASK_STOP_POLICY");
  const bootstrapKey = { pk: orgScoped(orgId, "TASK_STOP_SEED"), sk: "V1#bootstrap" };
  const upgradeKey = { pk: orgScoped(orgId, "TASK_STOP_SEED"), sk: "V1#upgrade" };
  // v2's capture reads the company's own record first and refuses a company that is closing or closed (or whose record is not there): such a company stays on Cloud's path, where it is refused.
  const org = await read(orgMetaKey(orgId));
  const policy = await read(policyKey);
  const bootstrap = await read(bootstrapKey);
  const upgrade = await read(upgradeKey);
  // The core start commits only while these rows are as they were read: a policy created or changed meanwhile (an enrollment turned on between the read and the commit) stops the start, which is then
  // asked again and reads the new state. A receipt is immutable once written, so only its absence is held.
  const fence: TaskStopRead["fence"] = [
    { kind: "check", key: policyKey, condition: policy === undefined ? when.absent() : when.eq("revision", policy["revision"] as number) },
    ...(bootstrap === undefined ? [{ kind: "check" as const, key: bootstrapKey, condition: when.absent() }] : []),
    ...(upgrade === undefined ? [{ kind: "check" as const, key: upgradeKey, condition: when.absent() }] : []),
  ];
  const orgOpen = org !== undefined && org["orgId"] === orgId && org["closingAt"] === undefined && org["closedAt"] === undefined;
  return { enrolled: !orgOpen || enrolledFromRows({ orgId, policy: [policyKey, policy], bootstrap: [bootstrapKey, bootstrap], upgrade: [upgradeKey, upgrade] }), fence };
}

export async function taskStopEnrolled(deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }, orgId: OrgId): Promise<boolean> {
  return (await readTaskStop(deps, orgId)).enrolled;
}

type Found = readonly [{ pk: string; sk: string }, Record<string, unknown> | undefined];

/** A row is the one asked for: its keys and its company are the ones read (v2's `row()`); anything else is invalid, which stays on Cloud's path. */
const isRow = ([key, item]: Found, orgId: string): boolean => item !== undefined && item["pk"] === key.pk && item["sk"] === key.sk && item["orgId"] === orgId;

function enrolledFromRows({ orgId, policy, bootstrap, upgrade }: { orgId: string; policy: Found; bootstrap: Found; upgrade: Found }): boolean {
  if (policy[1] === undefined && bootstrap[1] === undefined && upgrade[1] === undefined) return false;
  for (const [found, source] of [[bootstrap, "bootstrap"], [upgrade, "upgrade"]] as const) {
    if (found[1] !== undefined && (!isRow(found, orgId) || !receiptOk(found[1], source))) return true;
  }
  if (policy[1] === undefined || !isRow(policy, orgId)) return true;
  const row = policy[1];
  if (row["entityType"] !== "ORG_TASK_STOP_POLICY" || !positiveRevision(row["revision"]) || FORBIDDEN_CEILING_FIELDS.some((field) => Object.hasOwn(row, field))) return true;
  const enrollment = row["enrollment"];
  if (!object(enrollment) || enrollment["version"] !== 1) return true;
  return !(enrollment["state"] === "disabled" || enrollment["state"] === "ready");
}
