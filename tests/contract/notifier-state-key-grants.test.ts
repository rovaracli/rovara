import { readFileSync } from "node:fs";
import { adminChangeKey, sharedTaskKey } from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import { designWaitNotifyKey, designWaitRowKey } from "../../packages/broker/src/design-review/wait-rows.js";
import { plannerRepliesKey, taskKey, taskPointerKey } from "../../packages/broker/src/developer/task-records.js";
import { CONTROL_PLANE_LAMBDAS } from "../../scripts/test-deploy.js";
import { ITEM_ACTIONS, actionsByPrefix, grantedActions, notifierStatements, policyPatterns } from "../support/notifier-role-policy.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { prefixOfPk, sampleOfPrefix, scanStateKeyUses, type ItemAction } from "../support/state-key-uses.js";

// NOTIFY-DM-IAM (found live on staging, 0.5.14): the notifier read and updated the "NOTIFY_DM" rows that carry a person's attention DM, its role had no statement for that key, and every attention
// DM (and the 0.5.14 Slack-member warning, which uses the same rows) was refused by DynamoDB: the SlackDeliveryFailed alarm fired. The older guard (lambda-dynamodb-key-grants.test.ts) did not see it
// because a key whose action it cannot read passed on any DynamoDB statement, and the stream-read grant has no key condition.
//
// This guard reads every State-table call the notifier's entry file makes (tests/support/state-key-uses.ts), works out the partition prefix and the action of each, and compares them with the notifier
// role's synthesized policy in both directions: each prefix gets exactly the item actions the code uses on it, and each key pattern in the policy belongs to a prefix the code uses (or to one of the
// imported modules listed by hand below, whose key builders the scan cannot follow).

skipLambdaBundling();

const ENTRY = CONTROL_PLANE_LAMBDAS["developer-task-notifier"];
const repoRoot = new URL("../../", import.meta.url);
const source = readFileSync(new URL(ENTRY.entry, repoRoot), "utf8");

// --- the key builders the notifier calls, run for real, so a changed builder changes this list -----------------------------------------------------------------------------------------------
const thread = { teamId: "T0000001", channelId: "C0000001", threadTs: "1700000000.000100" };
const BUILDERS = {
  taskKey: [prefixOfPk(taskKey("t1").pk)],
  taskPointerKey: [prefixOfPk(taskPointerKey("w1").pk)],
  plannerRepliesKey: [prefixOfPk(plannerRepliesKey("t1", "a1").pk)],
  adminChangeKey: [prefixOfPk(adminChangeKey("c1").pk)],
  sharedTaskKey: [prefixOfPk(sharedTaskKey(thread).pk)],
  designWaitNotifyKey: [prefixOfPk(designWaitNotifyKey("t1", 1, "parked").pk)],
  // designWaitArmOf returns a whole UpdateItem input whose Key is the design wait row's key.
  designWaitArmOf: [prefixOfPk(designWaitRowKey("t1").pk)],
};

// Two variables hold NOTICE rows read back by a Query on `DEVTASK#<task>` (begins_with sk NOTICE#), so their updates are on DEVTASK# items.
const MEMBERS = { "updateWorkflowApprovalCard:marker": ["DEVTASK#"], "retireButtonCards:marker": ["DEVTASK#"] };

/**
 * Item actions the role holds on a prefix beyond what the entry file uses. Both come from the notifier's first read statement, which gives Get and Query to four prefixes together. They
 * are read-only on rows the notifier owns; splitting that statement would move the digests for no gain, so they are listed here and a new extra grant elsewhere still fails.
 */
const EXTRA_ALLOWED: Record<string, readonly ItemAction[]> = { "OPERATION#": ["GetItem"], "CHATGPT_NOTICE#": ["Query"] };

/** Key patterns the role holds for the imported modules the scan cannot follow: pattern to the module that uses it and a word that module must still contain. */
const IMPORTED_MODULE_GRANTS: Record<string, { file: string; mention: string; actions: ItemAction[] }> = {
  "ORG#org_????????????????????#WORK_EVENTS#*": { file: "packages/broker/src/work-events/store.ts", mention: "WORK_EVENTS#", actions: ["PutItem"] },
  "ORG#org_????????????????????#SESSION_BINDING#*": { file: "packages/broker/src/agent-sessions/bindings.ts", mention: "sessionBindingKey", actions: ["PutItem"] },
  "ORG#org_????????????????????#SESSION_SURFACE": { file: "packages/broker/src/agent-sessions/bindings.ts", mention: "sessionSurfaceKey", actions: ["PutItem"] },
  "ORG#org_????????????????????#AGENT_SESSION#*": { file: "packages/broker/src/agent-sessions/bindings.ts", mention: "ConditionCheck", actions: ["ConditionCheckItem"] },
  "ORG#org_????????????????????#SETTINGS": { file: "packages/broker/src/spend/estimate.ts", mention: "planRunLimit", actions: ["GetItem"] },
  "ORG#org_????????????????????#RUN_COST#*": { file: "packages/broker/src/spend/estimate.ts", mention: "RUN_COST", actions: ["Query"] },
  // deliverOwnerStopped asks canTakeOverNow: the person's company membership row (partition ORG#<org>, sk MEMBER#<dev>) and their project grant (partition ORG#<org>#MEMBER#<dev>), read only.
  "ORG#org_????????????????????": { file: "packages/broker/src/developer/take-over-eligible.ts", mention: "orgMemberKey", actions: ["GetItem"] },
  "ORG#org_????????????????????#MEMBER#*": { file: "packages/broker/src/developer/take-over-eligible.ts", mention: "projectMemberKey", actions: ["GetItem"] },
};

/** Spreads inside the entry's TransactWrite lists that come from another file, and why their keys are covered. Any other spread fails the scan. */
const ALLOWED_SPREADS = { binding: "bindingItemsForOpenSession (agent-sessions/bindings.ts): the session binding and surface puts and the session check, granted by the SESSION_BINDING#, SESSION_SURFACE and AGENT_SESSION# patterns above" };
/** Commands the entry sends that are not about the State table. */
const NON_TABLE_COMMANDS = ["GetObjectCommand", "PutObjectCommand", "GetSecretValueCommand", "SendMessageBatchCommand", "ChangeMessageVisibilityCommand"];

/**
 * Every module the entry file imports by a relative path and that mentions the table (a document client, a table name, a DynamoDB command) must be listed here with the exact names the entry takes
 * from it, and why that cannot reach a key the grants above do not cover. A new import from such a module, or a new name taken from a listed one, fails until it is read and listed. Not followed: what these
 * modules import in turn (the import graph from the entry is over a thousand modules); the scan of each module that is read for keys is below, the rest are pinned by their call-site count.
 */
const STATE_MODULES: Record<string, { names: string[]; why: string }> = {
  "../agent-sessions/bindings.js": { names: ["bindingItemsForOpenSession"], why: "builds the session binding items; granted by the SESSION_BINDING#, SESSION_SURFACE and AGENT_SESSION# patterns" },
  "../developer/notifications.js": { names: ["designWaitArms", "readStream"], why: "reads the stream's images; makes no call to the table" },
  "../design-review/wait-rows.js": { names: ["designWaitArmOf", "designWaitNotifyKey"], why: "key builders, run for real in BUILDERS" },
  "../agents/table-writes.js": { names: ["failedIndexes"], why: "reads a transaction error's cancel reasons; makes no call" },
  "./broker-shared.js": { names: ["isConditional"], why: "tests an error's name; makes no call" },
  "./admin-actions.js": { names: ["developerIdForSlackUser"], why: "pure id derivation; makes no call" },
  "./slack-ingress.js": { names: ["parseSlackSecrets"], why: "parses the Slack secret; makes no call" },
  "../developer/take-over-eligible.js": { names: ["canTakeOverNow"], why: "reads the person's membership and project grant; scanned below and granted by the two ORG# member patterns" },
  "../work-events/stream.js": { names: ["writeWorkEventsOfStream"], why: "puts work-event rows in the company's WORK_EVENTS# partitions; granted by that pattern" },
  "../spend/run-limit-change.js": { names: ["planRunLimitChange", "planRunLimitChangeLive", "waitsOnCodingPlan"], why: "does not mention the table itself; works the limit out through spend/estimate.ts, which reads the org's SETTINGS item and the RUN_COST# partition (waitsOnCodingPlan is a pure test)" },
};

/** The text of a file in the repository. */
const read = (file: string): string => readFileSync(new URL(file, repoRoot), "utf8");
const TABLE_MENTION = /lib-dynamodb|client-dynamodb|documentClient|\btableName\b|TableName/u;

const statements = notifierStatements();
const SCAN_OPTIONS = { builders: BUILDERS, members: MEMBERS, nonTableCommands: NON_TABLE_COMMANDS, allowedSpreads: ALLOWED_SPREADS };
const scan = scanStateKeyUses(source, SCAN_OPTIONS);
const used = actionsByPrefix(scan.uses);

describe("the notifier role's State-table grants match the keys and actions its code uses", () => {
  it("the scan resolves every State-table call the entry file makes (a key shape it cannot read fails here, it is never skipped)", () => {
    expect(scan.unresolved).toEqual([]);
    // Positive controls: the scan really sees the calls this guard exists for.
    expect(used.get("NOTIFY_DM")).toEqual(["GetItem", "UpdateItem"]);
    expect(used.get("WORKFLOW_DISPATCH")).toEqual(["GetItem"]);
    expect(used.get("CHATGPT_NOTICE#")).toEqual(["GetItem", "PutItem"]);
    expect(used.get("DEVTASK#")).toEqual(expect.arrayContaining(["GetItem", "PutItem", "UpdateItem", "Query"]));
    expect(used.get("SHARED_TASK#")).toEqual(["PutItem"]);
    expect(used.get("ADMIN_CHANGE#")).toEqual(["GetItem", "UpdateItem"]);
    // The settings-proof DM reads and writes only its own marker, never the project's partition (ORG#<org>#PROJECT#<name>).
    expect(used.get("NOTIFY_SETTINGS_PROOF#")).toEqual(["GetItem", "PutItem"]);
    expect([...used.keys()].filter((prefix) => prefix.startsWith("ORG#"))).toEqual([]);
    expect(grantedActions(statements, "ORG#org_aaaaaaaaaaaaaaaaaaaa#PROJECT#web")).toEqual([]);
  });

  it("each partition prefix the code touches is granted every item action the code uses on it, and no other (bar the listed extras)", () => {
    const wrong: string[] = [];
    for (const [prefix, actions] of [...used].sort()) {
      const granted = grantedActions(statements, sampleOfPrefix(prefix));
      const wanted = actions;
      const missing = wanted.filter((action) => !granted.includes(action));
      const extra = granted.filter((action) => !wanted.includes(action));
      if (missing.length > 0) wrong.push(`${prefix}: the code uses ${missing.join("+")} and the role does not grant it`);
      if (JSON.stringify(extra) !== JSON.stringify(EXTRA_ALLOWED[prefix] ?? [])) wrong.push(`${prefix}: the role grants ${extra.join("+") || "nothing"} beyond the code's use (expected ${(EXTRA_ALLOWED[prefix] ?? []).join("+") || "nothing"})`);
    }
    expect(wrong).toEqual([]);
  });

  it("every key pattern in the role's item grants belongs to a prefix the code uses, or to a listed imported module", () => {
    const code = new Set([...used.keys()].map((prefix) => (prefix.endsWith("#") ? `${prefix}*` : prefix)));
    const stray = policyPatterns(statements).filter((pattern) => !code.has(pattern) && IMPORTED_MODULE_GRANTS[pattern] === undefined);
    expect(stray).toEqual([]);
    for (const [pattern, { file, mention, actions }] of Object.entries(IMPORTED_MODULE_GRANTS)) {
      expect(readFileSync(new URL(file, repoRoot), "utf8"), `${file} still mentions ${mention}`).toContain(mention);
      const sample = pattern.replace(/\?/g, "a").replace(/\*/g, "x");
      expect(grantedActions(statements, sample), pattern).toEqual(actions);
    }
  });

  it("is not vacuous: without a NOTIFY_DM statement the guard names NOTIFY_DM, and a read grant is no write grant", () => {
    const without = statements.filter((statement) => !JSON.stringify(statement.Condition ?? {}).includes("NOTIFY_DM"));
    expect(grantedActions(without, "NOTIFY_DM")).toEqual([]);
    expect(grantedActions(statements, "NOTIFY_DM")).toEqual(["GetItem", "UpdateItem"]);
    for (const action of ["PutItem", "DeleteItem", "Query"] as const) expect(grantedActions(statements, "NOTIFY_DM")).not.toContain(action);
    expect(grantedActions(statements, "NOTIFY_DM2")).toEqual([]);
    expect(grantedActions(statements, "NOTIFY_DM#x")).toEqual([]);
    // A statement with no key condition allows every key; any condition this guard cannot read allows none; a stream grant is no item grant.
    expect(grantedActions([{ Effect: "Allow", Action: "dynamodb:*" }], "ANY#x")).toEqual(ITEM_ACTIONS);
    expect(grantedActions([{ Effect: "Allow", Action: "dynamodb:GetItem", Condition: { StringEquals: { "dynamodb:LeadingKeys": ["X"] } } }], "X")).toEqual([]);
    expect(grantedActions([{ Effect: "Allow", Action: ["dynamodb:GetRecords", "dynamodb:DescribeStream"] }], "NOTIFY_DM")).toEqual([]);
  });

  it("the scanner reads the shapes it claims to (literal key, local const, parameter, builder, transaction)", () => {
    const sample = [
      "async function a(deps) {",
      "  const key = { pk: \"ONE\", sk }; await getItem<T>(deps, key);",
      "  await deps.documentClient.send(new UpdateCommand({ TableName: t, Key: key }));",
      "}",
      "async function b(deps, marker) { await deps.documentClient.send(new PutCommand({ TableName: t, Item: { ...marker, x: 1 } })); }",
      "async function c(deps) { await b(deps, { pk: `TWO#${id}`, sk: \"s\" }); await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Update: { Key: taskKey(id) } }, { Put: { Item: { ...sharedTaskKey(x) } } }] })); }",
    ].join("\n");
    const result = scanStateKeyUses(sample, { builders: BUILDERS });
    expect(result.unresolved).toEqual([]);
    expect(actionsByPrefix(result.uses)).toEqual(new Map([["ONE", ["GetItem", "UpdateItem"]], ["TWO#", ["PutItem"]], ["DEVTASK#", ["UpdateItem"]], ["SHARED_TASK#", ["PutItem"]]]));
    expect(scanStateKeyUses("async function d(deps, k) { await getItem(deps, k); }", { builders: {} }).unresolved).toHaveLength(1);
  });
});

// --- keys built in imported helpers -------------------------------------------------------------------------------------------------------------------------------------------------------------
const TAKE_OVER = "packages/broker/src/developer/take-over-eligible.ts";
const TAKE_OVER_BUILDERS = { orgMemberKey: ["ORG#org_????????????????????"], projectMemberKey: ["ORG#org_????????????????????#MEMBER#*"] };
const COMMAND_CONSTRUCTORS = /\bnew (?:Get|Put|Update|Delete|Query|TransactWrite|TransactGet|BatchGet|BatchWrite|Scan)Command\(/gu;
/** How many table commands each listed file builds: a new call in a file the scan does not read key by key changes the count and fails until the file is read again. */
const PINNED_COMMAND_COUNTS: Record<string, number> = {
  "packages/broker/src/work-events/store.ts": 2,
  "packages/broker/src/agent-sessions/bindings.ts": 4,
  "packages/broker/src/spend/estimate.ts": 4,
};

/** What a file's own scan finds, against what IMPORTED_MODULE_GRANTS says that file uses. Empty when they agree. */
function moduleUseProblems(file: string, text: string, builders: Record<string, string[]>): string[] {
  const result = scanStateKeyUses(text, { builders });
  const found = actionsByPrefix(result.uses);
  const declared = new Map(Object.entries(IMPORTED_MODULE_GRANTS).filter(([, entry]) => entry.file === file).map(([pattern, entry]) => [pattern, entry.actions]));
  const problems = result.unresolved.map((entry) => `${file}:${String(entry.line)} cannot be read: ${entry.expression}`);
  for (const [pattern, actions] of found) if (JSON.stringify(declared.get(pattern)) !== JSON.stringify(actions)) problems.push(`${file} uses ${actions.join("+")} on ${pattern}, which IMPORTED_MODULE_GRANTS does not say`);
  for (const [pattern] of declared) if (!found.has(pattern)) problems.push(`${file} no longer uses ${pattern}`);
  return problems;
}

describe("keys built in imported helpers (fail closed)", () => {
  it("every module the entry imports by a relative path and that mentions the table is listed with exactly the names taken from it", () => {
    const entryUrl = new URL(ENTRY.entry, repoRoot);
    const taken = new Map<string, string[]>();
    for (const match of source.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"(\.{1,2}\/[^"]+)";/gmu)) {
      if (match[1] !== undefined) continue;
      const names = match[2]!.split(",").map((name) => name.trim()).filter((name) => name !== "" && !name.startsWith("type ")).map((name) => name.split(/\s+as\s+/u)[0]!).sort();
      if (names.length > 0) taken.set(match[3]!, [...(taken.get(match[3]!) ?? []), ...names].sort());
    }
    expect(source.match(/^import\s+(?!type\b)(?:\*\s+as\s+\w+|\w+)\s+from\s+"\./gmu) ?? [], "no default or namespace import from a relative path").toEqual([]);
    const touching = [...taken.keys()].filter((specifier) => TABLE_MENTION.test(readFileSync(new URL(specifier.replace(/\.js$/u, ".ts"), entryUrl), "utf8")) || STATE_MODULES[specifier] !== undefined);
    expect(touching.sort()).toEqual(Object.keys(STATE_MODULES).sort());
    for (const specifier of touching) expect({ [specifier]: taken.get(specifier) }, specifier).toEqual({ [specifier]: [...STATE_MODULES[specifier]!.names].sort() });
  });

  it("the module that reads the member rows uses exactly the keys listed for it, and a new key read there fails", () => {
    const text = read(TAKE_OVER);
    expect(moduleUseProblems(TAKE_OVER, text, TAKE_OVER_BUILDERS)).toEqual([]);
    // Mutations: a new read of another key, a read of a key the scan cannot read, and a new action on a listed key.
    const leaked = moduleUseProblems(TAKE_OVER, `${text}\nasync function leak(t: { documentClient: { send(c: unknown): Promise<unknown> } }) { await t.documentClient.send(new GetCommand({ TableName: "t", Key: { pk: "SECRET#x", sk: "A" } })); }\n`, TAKE_OVER_BUILDERS);
    expect(leaked.some((problem) => problem.includes("SECRET#"))).toBe(true);
    expect(moduleUseProblems(TAKE_OVER, `${text}\nasync function leak2(t: never, k: { pk: string; sk: string }) { await (t as never as { documentClient: { send(c: unknown): Promise<unknown> } }).documentClient.send(new PutCommand({ TableName: "t", Item: k })); }\n`, TAKE_OVER_BUILDERS).length).toBeGreaterThan(0);
    expect(moduleUseProblems(TAKE_OVER, text.replace("new GetCommand(", "new UpdateCommand("), TAKE_OVER_BUILDERS).length).toBeGreaterThan(0);
  });

  it("the other listed modules are pinned by how many table commands they build, and still mention their keys", () => {
    for (const [file, count] of Object.entries(PINNED_COMMAND_COUNTS)) expect(read(file).match(COMMAND_CONSTRUCTORS)?.length ?? 0, `${file} builds a new table command: read it, update IMPORTED_MODULE_GRANTS and this count`).toBe(count);
    for (const entry of Object.values(IMPORTED_MODULE_GRANTS)) expect(read(entry.file).includes(entry.mention), `${entry.file} mentions ${entry.mention}`).toBe(true);
    const files = new Set(Object.values(IMPORTED_MODULE_GRANTS).map((entry) => entry.file));
    for (const file of files) expect(file === TAKE_OVER || PINNED_COMMAND_COUNTS[file] !== undefined, `${file} is read by the scan or pinned`).toBe(true);
  });

  it("the transaction spread in the entry is the listed session-binding one, built by bindingItemsForOpenSession", () => {
    expect(source).toMatch(/const binding = [^;]*bindingItemsForOpenSession\(/u);
    expect(Object.keys(ALLOWED_SPREADS)).toEqual(["binding"]);
  });
});

describe("the scanner fails closed on shapes it cannot read", () => {
  const scan = (body: string, options: Partial<Parameters<typeof scanStateKeyUses>[1]> = {}) => scanStateKeyUses(`async function f(deps, key) {\n${body}\n}`, { builders: BUILDERS, ...options });
  it("any send whose argument is not a recognised command", () => {
    expect(scan("await deps.documentClient.send(command);").unresolved).toEqual([expect.objectContaining({ expression: expect.stringContaining("not a recognised command") as string })]);
    expect(scan("await deps.documentClient.send(new FrobCommand({ Key: key }));").unresolved).toHaveLength(1);
    expect(scan("await s3.send(new GetObjectCommand({ Bucket: b }));").unresolved).toHaveLength(1);
    expect(scan("await s3.send(new GetObjectCommand({ Bucket: b }));", { nonTableCommands: ["GetObjectCommand"] }).unresolved).toEqual([]);
  });
  it("a TransactItems spread unless the test names it and says why", () => {
    const body = "await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Put: { Item: { pk: `SHARED_TASK#x` } } }, ...items] }));";
    expect(scan(body).unresolved).toEqual([expect.objectContaining({ expression: expect.stringContaining("not allow-listed") as string })]);
    expect(scan(body, { allowedSpreads: { items: "reason" } }).unresolved).toEqual([]);
    expect(scan("await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...itemsBuiltElsewhere(deps)] }));").unresolved).toHaveLength(1);
  });
  it("BatchGet, BatchWrite, TransactGet and Scan are recognised and refused, not ignored", () => {
    for (const command of ["BatchGetCommand", "BatchWriteCommand", "TransactGetCommand", "ScanCommand"]) {
      const result = scan(`await deps.documentClient.send(new ${command}({ TableName: "t" }));`);
      expect(result.unresolved, command).toEqual([expect.objectContaining({ expression: expect.stringContaining(`${command}: recognised`) as string })]);
      expect(result.sites, command).toBe(1);
    }
  });
});
