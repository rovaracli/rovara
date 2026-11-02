// Setup and test health (SH17): the tests a maintainer marked "already failing" for a project, with the nightly baseline's own failing set. One small row per project. The result classifier (SH5) excuses a failure
// on the original code ("Partially verified: already failing") only when every such test is in the set this module answers with, so the set can only GROW by a maintainer's decision on a Fix setup card, in the same
// write that closes the card and records the audit event; nothing a worker, a model or a repository prints adds to it. Fail closed: a row that cannot be read or does not parse excuses nothing.
//
// Each mark is stored with the check it was marked for (`checkId`) and who marked it, when, and in which card (`epoch`): the classifier matches a mark on BOTH the test and the check, so a test marked for one check
// does not excuse the same name failing in another. A nightly failure has no check and matches the name in any check.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, projectPk, type OrgId } from "@agentx/contracts";
import { z } from "zod";
import type { TestEnvDeps } from "../org/test-environment.js";
import type { KnownFailingEntry } from "../verification/result.js";
import { usableNightlyFailing, type UsableNightlyOptions } from "./nightly-usable.js";

/** The most marks one project can have. A project with more has a bigger problem than a card can fix: a mark that would pass it is refused, not cut. */
export const KNOWN_FAILING_MAX = 500;
/** The longest test id a mark can carry: every name that is marked is shown in full on the card. */
export const KNOWN_FAILING_NAME_MAX = 200;
export const KNOWN_FAILING_FULL_MESSAGE = `This project's known-failing list is full (${String(KNOWN_FAILING_MAX)}). Remove some with Undo on the project page (Environment) before marking more.`;

/** A test id as the nightly run and the evidence name it: one token, no whitespace or hidden characters, short enough to be shown in full. */
export const KnownFailingTestId = z.string().min(1).max(KNOWN_FAILING_NAME_MAX).regex(/^[^\p{Cc}\p{Cf}\s]+$/u, "a test id has no whitespace or control characters");
const CheckId = z.string().min(1).max(64).regex(/^[^\p{Cc}\p{Cf}\s]+$/u);

export const KnownFailingMarkSchema = z.object({
  name: KnownFailingTestId,
  checkId: CheckId,
  markedBy: z.string().min(1).max(200),
  markedAt: z.string().datetime(),
  /** The Fix setup card (record epoch) the mark was made on. */
  epoch: z.number().int().min(1),
}).strict();
export type KnownFailingMark = z.infer<typeof KnownFailingMarkSchema>;

const RowSchema = z.object({
  marks: z.array(KnownFailingMarkSchema).max(KNOWN_FAILING_MAX),
  version: z.number().int().min(1),
  updatedAt: z.string().datetime(),
}).passthrough();

export const knownFailingKey = (orgId: OrgId, project: string) => ({ pk: projectPk(orgId, project), sk: "TESTENV#KNOWNFAILING" });

export interface KnownFailingRow { marks: KnownFailingMark[]; version: number }

/** The project's marks and the row's version (0: none yet). Undefined when the row cannot be read or does not parse: the caller treats that as "excuses nothing" and a writer refuses. */
export async function readKnownFailingRow(deps: Pick<TestEnvDeps, "documentClient" | "tableName">, orgId: OrgId, project: string): Promise<KnownFailingRow | undefined> {
  try {
    const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: knownFailingKey(orgId, project), ConsistentRead: true })) as { Item?: unknown };
    if (found.Item === undefined) return { marks: [], version: 0 };
    const parsed = RowSchema.safeParse(found.Item);
    return parsed.success ? { marks: parsed.data.marks, version: parsed.data.version } : undefined;
  } catch {
    return undefined;
  }
}

/** The tests the classifier may excuse: the last USABLE nightly's failures (`usableNightlyFailing`: recent, the task's base branch, whole; otherwise none; a name matches in any check) and the maintainers' marks (a name in one check). Each unreadable part adds nothing. */
export async function alreadyFailingForResults(deps: TestEnvDeps, orgId: OrgId, project: string, options: UsableNightlyOptions = {}): Promise<KnownFailingEntry[]> {
  const [nightly, marked] = await Promise.all([usableNightlyFailing(deps, orgId, project, options).then((failing) => failing ?? [], () => [] as string[]), readKnownFailingRow(deps, orgId, project)]);
  return [...nightly, ...(marked?.marks ?? []).map((mark) => ({ name: mark.name, checkId: mark.checkId }))];
}

/** The transaction item that writes `marks` as the project's set while the row is still at `version`. The caller checks the size first (`nextKnownFailing`). */
export function knownFailingWrite(deps: Pick<TestEnvDeps, "tableName">, orgId: OrgId, project: string, before: KnownFailingRow, marks: readonly KnownFailingMark[], nowIso: string) {
  const row = { ...knownFailingKey(orgId, project), entityType: "TEST_ENV_KNOWN_FAILING", orgId, project, marks: [...marks], version: before.version + 1, updatedAt: nowIso };
  return before.version === 0
    ? { Put: { TableName: deps.tableName, Item: row, ConditionExpression: "attribute_not_exists(pk)" } }
    : { Put: { TableName: deps.tableName, Item: row, ConditionExpression: "#version = :version", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":version": before.version } } };
}

/**
 * The set after adding `add` (each mark once per test and check; an existing mark keeps who made it), or throws a clear refusal when it would pass the limit. Order is kept.
 */
export function nextKnownFailing(before: KnownFailingRow, add: readonly KnownFailingMark[]): KnownFailingMark[] {
  const seen = new Set(before.marks.map((mark) => `${mark.checkId}\u0000${mark.name}`));
  const merged = [...before.marks];
  for (const mark of add) if (!seen.has(`${mark.checkId}\u0000${mark.name}`)) { seen.add(`${mark.checkId}\u0000${mark.name}`); merged.push(mark); }
  if (merged.length > KNOWN_FAILING_MAX) throw agentXError("CONFIG_INVALID", KNOWN_FAILING_FULL_MESSAGE);
  return merged;
}
