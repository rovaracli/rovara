import { readFileSync } from "node:fs";
import { adminChangeKey, sharedTaskKey, slackBindingKey } from "@rovara-code/contracts";
import { slackTeamOrgKey } from "@agentx/cloud-contracts";
import { describe, expect, it } from "vitest";
import { CONTROL_PLANE_LAMBDAS } from "../../scripts/test-deploy.js";
import { STATE_TABLE_LOGICAL_ID, allowsGetWithAttributes, attributeLimit, globToRegExp, grantedActions, itemActionsOf, list, patternsOf, roleStatements, statementsOnTable, type Statement } from "../support/notifier-role-policy.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { sampleOfPrefix, scanStateKeyUses, type ItemAction, type KeyUse } from "../support/state-key-uses.js";

// SLACK-STOP-IAM (found live on staging, 0.5.15): the Slack ingress Lambda serves the interactivity route, its task read asked for the `currentOwner` attribute, and its DEVTASK# grant listed five other
// attributes, so every Stop press was refused by DynamoDB. The older guard (lambda-dynamodb-key-grants.test.ts) reads only key literals, and notifier-state-key-grants.test.ts reads only the notifier.
//
// This is the notifier's guard for the Slack ingress Lambda, with one more dimension the notifier's role does not have: the ingress's State-table reads are limited by attribute (dynamodb:Attributes with a
// Null guard). It reads every call the Lambda's own two files make (slack-ingress.ts, and slack-interactivity.ts which the ingress serves), keeps the calls on the State table (the file's other tables
// are named below and pinned), and compares the partition key, the action and the attributes of each with the role's synthesized policy, in both directions. A call it cannot read fails, it is never skipped.

skipLambdaBundling();

const UNIT = "slack-ingress";
const ENTRY = CONTROL_PLANE_LAMBDAS[UNIT];
const FILES = [ENTRY.entry, "packages/broker/src/aws/slack-interactivity.ts"];
const repoRoot = new URL("../../", import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, repoRoot), "utf8");

// The key builders the two files call, run for real, so a changed builder changes the sample key here. A builder's "prefix" is the whole sample partition key.
const thread = { teamId: "T0000001", channelId: "C0000001", threadTs: "1700000000.000100" };
const BUILDERS = {
  slackBindingKey: [slackBindingKey("org_aaaaaaaaaaaaaaaaaaaa", "T0000001", "C0000001").pk],
  sharedTaskKey: [sharedTaskKey(thread).pk],
  adminChangeKey: [adminChangeKey("c1").pk],
};

/** TableName texts: the State table's, and the tables the same document client reaches (the Slack threads table, a full read-write grant of its own; the turn records table is read by the imported slack-details.ts). */
const TABLES = { state: ["stateTableName"], other: ["threadsTableName", "tableName", "input.tableName"] };
/** `tableName` / `input.tableName` are the parameter of a factory the file calls (createUnlinkedChannelNoticeStore, threadPendingCounter): every call must pass the threads table (checked below). */
const NON_TABLE_COMMANDS = ["GetSecretValueCommand", "SendMessageCommand", "InvokeCommand"];
const NON_TABLE_ARGUMENTS = ["{ v: 1, op:"];

const statements = statementsOnTable(roleStatements(UNIT), STATE_TABLE_LOGICAL_ID);
const options = { builders: BUILDERS, nonTableCommands: NON_TABLE_COMMANDS, nonTableArguments: NON_TABLE_ARGUMENTS, tables: TABLES };
const scans = FILES.map((file) => ({ file, ...scanStateKeyUses(read(file), options) }));
const uses: KeyUse[] = scans.flatMap((scan) => scan.uses);

/** The keys the Lambda reads through modules the scan cannot follow, with what each module must still say. */
const IMPORTED_USES: Array<{ sample: string; action: ItemAction; attributes: string[] | null; file: string; mention: string }> = [
  // resolveSlackOrg(new OrgStore(...), teamId) reads the Slack team's org pointer, whole.
  { sample: slackTeamOrgKey("T0000001").pk, action: "GetItem", attributes: null, file: "packages/broker/src/org/store.ts", mention: "this.get(slackTeamOrgKey(teamId))" },
];

/** Every module the files import by a relative path and that mentions a table, with the names taken from it and why that reaches no State key the grants do not cover. */
const STATE_MODULES: Record<string, { names: string[] | "any"; why: string }> = {
  "../org/store.js": { names: ["OrgStore"], why: "only resolveSlackOrg(new OrgStore(...), teamId) uses it: orgForSlackTeam, the SLACK_TEAM# pointer read listed in IMPORTED_USES" },
  "../team-record/slack-add.js": { names: ["LEARN_ADD_ACTION", "askThroughBroker", "botInvite", "isHandedOffLearnPress", "isLearnFromChannel", "learnAddHandler", "offerLearnPrompt", "runHandedOffLearnPress"],
    why: "the handlers hand the press to the broker and answer; createSlackAdd, which builds an OrgStore on the State table, is not imported here" },
  "./slack-details.js": { names: ["detailsActionHandler", "dynamoTurnDetailsReader"], why: "reads one turn record from the turn records table (its own role statement), not the State table" },
  "./slack-interactivity.js": { names: ["createAwsSlackInteractivityHandler"], why: "the second file scanned here" },
  "./slack-ingress.js": { names: "any", why: "the first file scanned here (slack-interactivity.ts takes its secret parser and helpers from it)" },
  // Its only table call is the choice store, which takes its table as a parameter: every call below passes the threads table, so any name may be taken from it.
  "./slack-workflow-choice.js": { names: "any", why: "the choice store is built on the threads table (every createDynamoWorkflowChoiceStore call is checked below)" },
};

const sampleOf = (use: { prefix: string }): string => sampleOfPrefix(use.prefix);

describe("the Slack ingress role's State-table grants match the keys, actions and attributes its code uses", () => {
  it("the scan reads every State-table call of both files (a call it cannot read fails here, it is never skipped)", () => {
    for (const scan of scans) expect(scan.unresolved, scan.file).toEqual([]);
    // Positive controls: the scan really sees the calls this guard exists for.
    const task = uses.filter((use) => use.prefix === "DEVTASK#");
    expect(task.map((use) => [use.action, use.attributes])).toEqual([["GetItem", ["pk", "sk", "slackUserId", "share", "workflow", "currentOwner"]]]);
    expect(uses.filter((use) => use.prefix.startsWith("ADMIN_CHANGE#")).map((use) => [use.action, use.attributes])).toEqual([["GetItem", ["pk", "sk", "traceId"]]]);
    expect(uses.filter((use) => use.prefix.startsWith("SHARED_TASK#")).map((use) => use.action)).toEqual(["GetItem"]);
    expect(uses.filter((use) => use.prefix.includes("#SLACK_BINDING#")).map((use) => use.action)).toEqual(["GetItem"]);
    // Nothing on the threads table is counted as a State use.
    expect(uses.filter((use) => use.prefix.startsWith("EVENT#") || use.prefix.startsWith("THREAD#"))).toEqual([]);
  });

  it("each key the code reads is granted for that action, with the attributes it names, and the role grants nothing else on it", () => {
    const wrong: string[] = [];
    const all = [...uses.map((use) => ({ sample: sampleOf(use), action: use.action, attributes: use.attributes })), ...IMPORTED_USES];
    for (const use of all) {
      if (!grantedActions(statements, use.sample).includes(use.action)) wrong.push(`${use.sample}: the code uses ${use.action} and the role does not grant it`);
      if (use.action === "GetItem" && !allowsGetWithAttributes(statements, use.sample, use.attributes === undefined || use.attributes === null ? undefined : use.attributes)) {
        wrong.push(`${use.sample}: the read names ${use.attributes === null || use.attributes === undefined ? "no attributes (all)" : use.attributes.join(",")} and no statement allows that`);
      }
    }
    const samples = [...new Set(all.map((use) => use.sample))];
    for (const sample of samples) {
      const wanted = [...new Set(all.filter((use) => use.sample === sample).map((use) => use.action))];
      const extra = grantedActions(statements, sample).filter((action) => !wanted.includes(action));
      if (extra.length > 0) wrong.push(`${sample}: the role grants ${extra.join("+")} beyond the code's use`);
    }
    expect(wrong).toEqual([]);
  });

  it("each attribute list in the policy is exactly what the reads of that key name, and carries the Null guard (no read without a projection)", () => {
    const wrong: string[] = [];
    const reads = [...uses.map((use) => ({ sample: sampleOf(use), attributes: use.attributes })), ...IMPORTED_USES.map((use) => ({ sample: use.sample, attributes: use.attributes }))].filter((use) => use.attributes !== undefined);
    for (const statement of statements) {
      const limit = attributeLimit(statement);
      if (limit === undefined || statement.Effect !== "Allow") continue;
      const patterns = patternsOf(statement);
      if (patterns === "any" || patterns === "unreadable") { wrong.push(`an attribute-limited statement with ${patterns} key patterns`); continue; }
      if (!limit.mustName) wrong.push(`${patterns.join(",")}: the attribute list has no Null guard`);
      const named = new Set(reads.filter((read) => patterns.some((pattern) => globToRegExp(pattern).test(read.sample))).flatMap((read) => read.attributes ?? []));
      if (JSON.stringify([...named].sort()) !== JSON.stringify([...limit.allowed].sort())) wrong.push(`${patterns.join(",")}: the policy lists ${limit.allowed.join(",")}, the code names ${[...named].join(",")}`);
      expect(list(statement.Action).every((action) => action === "dynamodb:GetItem"), patterns.join(",")).toBe(true);
    }
    expect(wrong).toEqual([]);
  });

  it("every key pattern in the role's item grants belongs to a key the code reads", () => {
    const samples = [...uses.map(sampleOf), ...IMPORTED_USES.map((use) => use.sample)];
    const stray: string[] = [];
    for (const statement of statements.filter((candidate) => candidate.Effect === "Allow" && itemActionsOf(candidate).length > 0)) {
      const patterns = patternsOf(statement);
      if (patterns === "any" || patterns === "unreadable") { stray.push(`<${patterns}> ${list(statement.Action).join(",")}`); continue; }
      for (const pattern of patterns) if (!samples.some((sample) => globToRegExp(pattern).test(sample))) stray.push(pattern);
    }
    expect(stray).toEqual([]);
  });

  it("the other tables are named exactly: every call that reaches one passes the threads table, and the imported modules are listed with the names taken from them", () => {
    // The factories' own `tableName` parameter is the threads table at every call.
    const calls = FILES.flatMap((file) => [...read(file).matchAll(/(?<!function )(?:createUnlinkedChannelNoticeStore|threadPendingCounter|createDynamoWorkflowChoiceStore)\([^)]*\)/gu)].map((match) => match[0]));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call, call).toContain("threadsTableName");
    const taken = new Map<string, string[]>();
    for (const file of FILES) {
      for (const match of read(file).matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"(\.{1,2}\/[^"]+)";/gmu)) {
        if (match[1] !== undefined) continue;
        const names = match[2]!.split(",").map((name) => name.trim()).filter((name) => name !== "" && !name.startsWith("type ")).map((name) => name.split(/\s+as\s+/u)[0]!);
        if (names.length > 0) taken.set(match[3]!, [...(taken.get(match[3]!) ?? []), ...names]);
      }
    }
    const TABLE_MENTION = /lib-dynamodb|client-dynamodb|documentClient|\btableName\b|TableName/u;
    const entryUrl = new URL(ENTRY.entry, repoRoot);
    const touching = [...taken.keys()].filter((specifier) => TABLE_MENTION.test(readFileSync(new URL(specifier.replace(/\.js$/u, ".ts"), entryUrl), "utf8")));
    for (const specifier of touching) {
      expect(STATE_MODULES[specifier], `${specifier} mentions a table: read it, say why it reaches no State key the grants do not cover, and list it`).toBeDefined();
      const names = [...new Set(taken.get(specifier))].sort();
      const listed = STATE_MODULES[specifier]!.names === "any" ? names : [...STATE_MODULES[specifier]!.names].sort();
      // The two files import each other's and the modules' names separately: a name taken that is not listed fails.
      expect(names.filter((name) => !listed.includes(name)), `${specifier}: a name taken from it that is not listed`).toEqual([]);
    }
    for (const entry of IMPORTED_USES) expect(read(entry.file), `${entry.file} still has ${entry.mention}`).toContain(entry.mention);
    expect(read("packages/broker/src/org/resolve.ts")).toContain("orgs.orgForSlackTeam(teamId)");
    expect(read(ENTRY.entry)).toMatch(/resolveSlackOrg\(new OrgStore\(\{ documentClient, tableName: stateTableName/u);
  });

  it("is not vacuous: a role without the DEVTASK# attribute grant, or with a shorter attribute list, is named by this guard", () => {
    const without = statements.filter((statement) => !JSON.stringify(statement.Condition ?? {}).includes("DEVTASK#"));
    expect(allowsGetWithAttributes(without, "DEVTASK#x0", ["pk", "sk"])).toBe(false);
    const task = statements.find((statement) => JSON.stringify(statement.Condition ?? {}).includes("DEVTASK#"))!;
    expect(allowsGetWithAttributes([task], "DEVTASK#x0", ["pk", "sk", "slackUserId", "share", "workflow", "currentOwner"])).toBe(true);
    // The staging failure: one attribute short.
    const short: Statement = { ...task, Condition: { ...task.Condition, "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "slackUserId", "share", "workflow"] } } };
    expect(allowsGetWithAttributes([short], "DEVTASK#x0", ["pk", "sk", "slackUserId", "share", "workflow", "currentOwner"])).toBe(false);
    // A read that names no attributes returns every attribute: the Null guard refuses it.
    expect(allowsGetWithAttributes([task], "DEVTASK#x0", undefined)).toBe(false);
    expect(allowsGetWithAttributes([{ ...task, Condition: { "ForAllValues:StringLike": task.Condition!["ForAllValues:StringLike"]!, "ForAllValues:StringEquals": task.Condition!["ForAllValues:StringEquals"]! } }], "DEVTASK#x0", undefined)).toBe(true);
    // Another key, and another action, are not granted.
    expect(grantedActions(statements, "DEVTASK#x0")).toEqual(["GetItem"]);
    expect(grantedActions(statements, "WORKSPACE#x0")).toEqual([]);
  });
});

describe("the scanner's table and attribute reading fails closed", () => {
  const scan = (body: string, extra: Partial<Parameters<typeof scanStateKeyUses>[1]> = {}) => scanStateKeyUses(`async function f(deps, id) {\n${body}\n}`, { builders: {}, tables: TABLES, ...extra });
  it("reads the projected attributes, with aliases resolved, and null when a Get names none", () => {
    const named = scan("await deps.documentClient.send(new GetCommand({ TableName: stateTableName, Key: { pk: `DEVTASK#${id}`, sk: \"META\" }, ProjectionExpression: \"pk, #share, workflow\", ExpressionAttributeNames: { \"#share\": \"share\" } }));");
    expect(named.unresolved).toEqual([]);
    expect(named.uses).toEqual([expect.objectContaining({ prefix: "DEVTASK#", action: "GetItem", attributes: ["pk", "share", "workflow"] })]);
    expect(scan("await deps.documentClient.send(new GetCommand({ TableName: stateTableName, Key: { pk: `DEVTASK#${id}`, sk: \"META\" } }));").uses[0]!.attributes).toBeNull();
  });
  it("a ProjectionExpression that is not a literal string fails", () => {
    expect(scan("await deps.documentClient.send(new GetCommand({ TableName: stateTableName, Key: { pk: `DEVTASK#${id}`, sk: \"META\" }, ProjectionExpression: fields }));").unresolved).toHaveLength(1);
  });
  it("a call on a table that is not listed, or with no TableName, fails; a call on a listed other table is not a State use", () => {
    expect(scan("await deps.documentClient.send(new PutCommand({ TableName: auditTableName, Item: { pk: `X#${id}`, sk: \"s\" } }));").unresolved).toEqual([expect.objectContaining({ expression: expect.stringContaining("auditTableName") as string })]);
    expect(scan("await deps.documentClient.send(new PutCommand({ Item: { pk: `X#${id}`, sk: \"s\" } }));").unresolved).toHaveLength(1);
    const other = scan("await deps.documentClient.send(new PutCommand({ TableName: threadsTableName, Item: { pk: `EVENT#${id}`, sk: \"s\" } }));");
    expect(other.unresolved).toEqual([]);
    expect(other.uses).toEqual([]);
  });
  it("a TransactWrite member on an unlisted table fails", () => {
    expect(scan("await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: auditTableName, Item: { pk: `X#${id}` } } }] }));").unresolved).toHaveLength(1);
  });
  it("a send that is not a command fails unless its argument is listed", () => {
    expect(scan("await queue.send({ v: 1, op: \"x\" });").unresolved).toHaveLength(1);
    expect(scan("await queue.send({ v: 1, op: \"x\" });", { nonTableArguments: NON_TABLE_ARGUMENTS }).unresolved).toEqual([]);
  });
});
