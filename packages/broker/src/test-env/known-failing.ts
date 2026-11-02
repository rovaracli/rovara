// Setup and test health (SH17): the tests a maintainer marked "already failing" for a project, with the nightly baseline's own failing set. One small row per project. The result classifier (SH5) excuses a failure
// on the original code ("Partially verified: already failing") only when every such test is in the set this module answers with, so the set can only GROW by a maintainer's decision on a Fix setup card, in the same
// write that closes the card and records the audit event; nothing a worker, a model or a repository prints adds to it. Fail closed: a row that cannot be read or does not parse excuses nothing.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { projectPk, type OrgId } from "@agentx/contracts";
import { z } from "zod";
import type { TestEnvDeps } from "../org/test-environment.js";
import { alreadyFailingTests } from "./nightly.js";

/** The most tests one project can have marked. A project with more failing tests than this has a bigger problem than a card can fix: the mark is refused, not cut. */
export const KNOWN_FAILING_MAX = 500;

/** A test id as the nightly run and the evidence name it: one token, no whitespace or hidden characters. */
export const KnownFailingTestId = z.string().min(1).max(500).regex(/^[^\p{Cc}\p{Cf}\s]+$/u, "a test id has no whitespace or control characters");

const RowSchema = z.object({
  tests: z.array(KnownFailingTestId).max(KNOWN_FAILING_MAX),
  version: z.number().int().min(1),
  updatedAt: z.string().datetime(),
}).passthrough();

export const knownFailingKey = (orgId: OrgId, project: string) => ({ pk: projectPk(orgId, project), sk: "TESTENV#KNOWNFAILING" });

export interface KnownFailingRow { tests: string[]; version: number }

/** The project's marked tests and the row's version (0: none yet). Undefined when the row cannot be read or does not parse: the caller treats that as "excuses nothing" and a writer refuses. */
export async function readKnownFailingRow(deps: Pick<TestEnvDeps, "documentClient" | "tableName">, orgId: OrgId, project: string): Promise<KnownFailingRow | undefined> {
  try {
    const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: knownFailingKey(orgId, project), ConsistentRead: true })) as { Item?: unknown };
    if (found.Item === undefined) return { tests: [], version: 0 };
    const parsed = RowSchema.safeParse(found.Item);
    return parsed.success ? { tests: parsed.data.tests, version: parsed.data.version } : undefined;
  } catch {
    return undefined;
  }
}

/** The tests the classifier may excuse: the last nightly's failures (`alreadyFailingTests`, empty when truncated) and the maintainer's marks. Each unreadable part adds nothing. */
export async function alreadyFailingForResults(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<string[]> {
  const [nightly, marked] = await Promise.all([alreadyFailingTests(deps, orgId, project).catch(() => [] as string[]), readKnownFailingRow(deps, orgId, project)]);
  return [...new Set([...nightly, ...(marked?.tests ?? [])])];
}

/** The transaction item that adds `tests` to the project's marks while the row is still at `version`. The caller checks the size first (`nextKnownFailing`). */
export function knownFailingWrite(deps: Pick<TestEnvDeps, "tableName">, orgId: OrgId, project: string, before: KnownFailingRow, tests: readonly string[], nowIso: string) {
  const row = { ...knownFailingKey(orgId, project), entityType: "TEST_ENV_KNOWN_FAILING", orgId, project, tests: [...tests], version: before.version + 1, updatedAt: nowIso };
  return before.version === 0
    ? { Put: { TableName: deps.tableName, Item: row, ConditionExpression: "attribute_not_exists(pk)" } }
    : { Put: { TableName: deps.tableName, Item: row, ConditionExpression: "#version = :version", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":version": before.version } } };
}

/** The set after adding `add`, or undefined when it would not fit (the mark is refused). Order is kept; a test appears once. */
export function nextKnownFailing(before: KnownFailingRow, add: readonly string[]): string[] | undefined {
  const merged = [...new Set([...before.tests, ...add])];
  return merged.length <= KNOWN_FAILING_MAX ? merged : undefined;
}
