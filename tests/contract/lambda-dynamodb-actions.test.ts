import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTROL_PLANE_LAMBDAS } from "../../scripts/test-deploy.js";
import { actionsIn, reachableDynamoCalls, type DynamoAction } from "../support/lambda-reachability.js";
import { STATE_TABLE_LOGICAL_ID, globToRegExp, list, roleStatementsOf, statementsOnTable, type Statement } from "../support/notifier-role-policy.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

// REACH-1 (0.5.15.1): three Lambdas of 0.5.15 were refused by DynamoDB on staging for a call their role never granted: the Slack ingress read an attribute (`currentOwner`) its DEVTASK# statement did not list
// (Stop and Close), and the realtime authorizer made a BatchGetItem (the owner's name) its role never held. The key scanners (state-key-uses.ts) read keys in one entry file; none asked the broader question
// "can this Lambda's code reach this DynamoDB ACTION at all, and does its role hold it?". This does, for every control-plane Lambda and the realtime authorizer, from the code reachable from the entry file
// (lambda-reachability.ts: the entry whole, then every top-level function, class or const that reached code mentions, through relative imports and re-exports), against the role's synthesized State-table
// statements, for every DynamoDB item action including BatchGetItem, BatchWriteItem and Scan.
//
// The walk over-approximates (a class is one unit; a name in a string counts), so what it finds but the role lacks is PINNED below, per Lambda and file, each group with the reason it is not a gap. A NEW
// reachable-but-ungranted action, or a pinned one that is gone, fails: the list is exact. A construct the walk cannot follow (dynamic import, `import * as`) is in `unresolved` and is pinned the same way.
// What this does not check: the key and the attributes of a call whose action the role holds only for some keys (state-key-uses.ts and the per-Lambda key guards do), and tables other than State.

skipLambdaBundling();

const repoRoot = new URL("../../", import.meta.url);
const ROLES: Record<string, { logicalId: string; entry: string }> = {
  ...Object.fromEntries(Object.entries(CONTROL_PLANE_LAMBDAS).map(([unit, spec]) => [unit, { logicalId: spec.logicalId, entry: spec.entry }])),
  "realtime-authorizer": { logicalId: "RealtimeAuthorizer74F9F06D", entry: "packages/broker/src/realtime/authorizer.ts" },
};
const ALL: DynamoAction[] = ["GetItem", "PutItem", "UpdateItem", "DeleteItem", "Query", "Scan", "BatchGetItem", "BatchWriteItem", "ConditionCheckItem"];
const read = (file: string): string => readFileSync(new URL(file, repoRoot), "utf8");

/** The item actions the role's statements on the State table allow, whatever their key or attribute conditions (those are the key guards' business). */
function grantedOnState(statements: readonly Statement[]): DynamoAction[] {
  let state: Statement[];
  try { state = statementsOnTable(statements, STATE_TABLE_LOGICAL_ID); } catch { state = []; }
  const granted = new Set<DynamoAction>();
  for (const statement of state) {
    if (statement.Effect !== "Allow") continue;
    for (const action of list(statement.Action)) {
      if (!action.toLowerCase().startsWith("dynamodb:")) continue;
      const pattern = globToRegExp(action.toLowerCase());
      for (const candidate of ALL) if (pattern.test(`dynamodb:${candidate}`.toLowerCase())) granted.add(candidate);
    }
  }
  return ALL.filter((action) => granted.has(action));
}

interface Pin { why: string; files: Record<string, string> }
/** Per Lambda: what its reachable code constructs that its role does not grant on the State table, by file (actions joined by +), with the reason each group is not a gap. */
const PINS: Record<string, Pin[]> = {
  "slack-ingress": [
    {
      why: "The Slack threads table: its own full read-write grant (slackThreads.grantReadWriteData). The EVENT#, THREAD# and choice rows are written there; slack-ingress-state-key-grants.test.ts names every call on the State table and refuses a TableName it does not list.",
      files: {
        "packages/broker/src/aws/slack-ingress.ts": "PutItem+UpdateItem+DeleteItem",
        "packages/broker/src/aws/slack-interactivity.ts": "PutItem+UpdateItem+DeleteItem",
        "packages/broker/src/aws/slack-workflow-choice.ts": "PutItem+UpdateItem+DeleteItem",
      },
    },
    {
      why: "OrgStore (org/store.ts) is one unit: the ingress builds it only for resolveSlackOrg, which calls orgForSlackTeam, one GetItem (pinned in slack-ingress-state-key-grants.test.ts IMPORTED_USES). The rest of the class, and the modules it imports, are not called.",
      files: {
        "packages/broker/src/org/store.ts": "PutItem+UpdateItem+DeleteItem+Query+ConditionCheckItem",
        "packages/broker/src/org/project-allowed-domains-cleanup.ts": "DeleteItem+Query+ConditionCheckItem",
        "packages/broker/src/org/project-working-branch-receipt-cleanup.ts": "DeleteItem+Query+ConditionCheckItem",
        "packages/broker/src/org/track-record-cleanup.ts": "DeleteItem+Query+ConditionCheckItem",
        "packages/broker/src/org/member-removal/access.ts": "DeleteItem",
        "packages/broker/src/org/member-removal/finish.ts": "UpdateItem+DeleteItem",
        "packages/broker/src/org/member-removal/start.ts": "Query",
        "packages/broker/src/org/project-members.ts": "Query",
        "packages/broker/src/audit/flush.ts": "DeleteItem",
        "packages/broker/src/audit/outbox.ts": "PutItem+UpdateItem+DeleteItem",
        "packages/broker/src/developer/page-comments.ts": "UpdateItem",
      },
    },
  ],
  "developer-sign-in": [
    {
      why: "DeveloperSignInStore reads the name rows (BatchGetItem) only when it is built with nameTableName; the sign-in function builds it without one (checked below), so the reads in getDeveloper and getDevelopersWithNameItems are not made.",
      files: { "packages/broker/src/developer/chosen-name.ts": "BatchGetItem" },
    },
  ],
  "realtime-authorizer": [
    {
      why: "resolveSessionAccess builds AgentSessionStore (one unit) to read a session; the authorizer's access is read-only (readOnlyPath), and the put in the store is the session's creation, never made here.",
      files: { "packages/broker/src/agent-sessions/store.ts": "PutItem" },
    },
  ],
};
/** Constructs the walk cannot follow, per Lambda: pinned so a new one is read. The broker's are lazy loads of store modules by the agent, chain and learning stores. */
// The `(a value)` lines below are methods named `require` (a store's own `require`, the Cloud root's `registry.require(point)` and its type), not module requires: each was read. S3-10: the Cloud root's files
// arrived with the root (the broker's entry since S3, and the dispatcher's core host, which the walk now follows through its literal dynamic import, as it now follows learning/settings.ts's ./grouping.js).
const ROOT_REGISTRY_REQUIRES = [
  "packages/broker/src/cloud/app/cloud-modules.ts: dynamic import or require of (a value)",
  "packages/broker/src/cloud/app/core-runtime.ts: dynamic import or require of (a value)",
  "packages/broker/src/cloud/app/entry.ts: dynamic import or require of (a value)",
  "packages/broker/src/cloud/app/runtime.ts: dynamic import or require of (a value)",
  "packages/broker/src/cloud/app/step-fence.ts: dynamic import or require of (a value)",
];
const UNRESOLVED: Record<string, string[]> = {
  broker: [
    "packages/broker/src/agents/owned-store.ts: dynamic import or require of (a value)",
    "packages/broker/src/agents/store.ts: dynamic import or require of (a value)",
    "packages/broker/src/chains/store.ts: dynamic import or require of (a value)",
    ...ROOT_REGISTRY_REQUIRES,
  ].sort(),
  dispatcher: [
    "packages/broker/src/agents/owned-store.ts: dynamic import or require of (a value)",
    "packages/broker/src/agents/store.ts: dynamic import or require of (a value)",
    ...ROOT_REGISTRY_REQUIRES,
  ].sort(),
};

describe("every Lambda's reachable DynamoDB actions are granted on the State table, or pinned with a reason", () => {
  it("covers every Lambda test-deploy moves, and the realtime authorizer", () => {
    expect(Object.keys(ROLES).sort()).toEqual([...Object.keys(CONTROL_PLANE_LAMBDAS), "realtime-authorizer"].sort());
    for (const [unit, { logicalId }] of Object.entries(ROLES)) expect(() => roleStatementsOf(logicalId), unit).not.toThrow();
  });

  for (const [unit, { logicalId, entry }] of Object.entries(ROLES)) {
    it(`${unit}: what its code can reach and its role lacks is exactly the pinned list`, () => {
      const reach = reachableDynamoCalls(entry, repoRoot);
      expect(reach.calls.length, "the walk finds table calls").toBeGreaterThan(0);
      const granted = grantedOnState(roleStatementsOf(logicalId));
      const found = new Map<string, Set<DynamoAction>>();
      for (const call of reach.calls) if (!granted.includes(call.action)) found.set(call.file, (found.get(call.file) ?? new Set()).add(call.action));
      const actual = Object.fromEntries([...found].sort(([a], [b]) => a.localeCompare(b)).map(([file, actions]) => [file, ALL.filter((action) => actions.has(action)).join("+")]));
      const pinned: Record<string, string> = {};
      for (const pin of PINS[unit] ?? []) for (const [file, actions] of Object.entries(pin.files)) pinned[file] = ALL.filter((action) => actions.split("+").includes(action)).join("+");
      const sorted = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
      expect(sorted(actual), `${unit}: reachable DynamoDB actions its role does not hold on the State table (add the grant, or pin it with the reason it is not a gap)`).toEqual(sorted(pinned));
      expect(reach.unresolved, `${unit}: constructs the walk cannot follow`).toEqual(UNRESOLVED[unit] ?? []);
    });
  }

  it("positive controls: the authorizer's code reaches the name read's BatchGetItem, and its role now holds it; the ingress and the notifier are read", () => {
    const reach = reachableDynamoCalls(ROLES["realtime-authorizer"]!.entry, repoRoot);
    expect(reach.calls).toContainEqual({ action: "BatchGetItem", command: "BatchGetCommand", file: "packages/broker/src/developer/chosen-name.ts", unit: "readNameItems" });
    expect(grantedOnState(roleStatementsOf("RealtimeAuthorizer74F9F06D"))).toEqual(["GetItem", "Query", "BatchGetItem"]);
    const ingress = reachableDynamoCalls(ROLES["slack-ingress"]!.entry, repoRoot);
    expect(ingress.calls.some((call) => call.file.endsWith("slack-interactivity.ts") && call.action === "GetItem")).toBe(true);
    const notifier = reachableDynamoCalls(ROLES["developer-task-notifier"]!.entry, repoRoot);
    expect(notifier.calls.some((call) => call.action === "UpdateItem" && call.file.endsWith("developer-task-notifier.ts"))).toBe(true);
  });

  it("the reasons pinned above still hold in the code", () => {
    // The sign-in function builds its stores without a name table, so it never reads the name rows.
    expect(read("packages/broker/src/aws/developer-identity.ts")).not.toContain("nameTableName");
    expect(read("packages/broker/src/developer/store.ts")).toMatch(/const nameTable = this\.input\.nameTableName;\n\s+if \(nameTable === undefined\)|nameTable === undefined \? Promise\.resolve/u);
    // The authorizer reads sessions on the read-only path and never creates one.
    expect(read("packages/broker/src/realtime/authorizer.ts")).toContain("readOnlyPath: true");
  });
});

describe("the walk reads units, follows imports and re-exports, and fails closed", () => {
  function fixture(files: Record<string, string>): URL {
    const root = mkdtempSync(join(tmpdir(), "reach-"));
    for (const [name, text] of Object.entries(files)) { mkdirSync(join(root, name, ".."), { recursive: true }); writeFileSync(join(root, name), text); }
    return pathToFileURL(`${root}/`);
  }
  it("counts the actions of a unit the entry mentions, through an import and a re-export, and not one it never mentions", () => {
    const root = fixture({
      "entry.ts": "import { readThing } from \"./barrel.js\";\nexport const handler = async (d) => { await readThing(d); };\n",
      "barrel.ts": "export { readThing } from \"./store.js\";\n",
      "store.ts": [
        "import { BatchGetCommand, PutCommand } from \"@aws-sdk/lib-dynamodb\";",
        "export async function readThing(d) { await d.send(new BatchGetCommand({ RequestItems: {} })); }",
        "export async function writeThing(d) { await d.send(new PutCommand({ TableName: \"t\" })); }",
        "",
      ].join("\n"),
    });
    const reach = reachableDynamoCalls("entry.ts", root);
    expect(reach.calls.map((call) => [call.action, call.file, call.unit])).toEqual([["BatchGetItem", "store.ts", "readThing"]]);
    expect(reach.unresolved).toEqual([]);
  });
  it("a unit of the entry itself is reached whole, and a transaction counts the action of each member", () => {
    const root = fixture({ "entry.ts": "export const handler = async (d) => { await d.send(new TransactWriteCommand({ TransactItems: [{ Update: {} }, { ConditionCheck: {} }] })); };\n" });
    expect(reachableDynamoCalls("entry.ts", root).calls.map((call) => call.action).sort()).toEqual(["ConditionCheckItem", "UpdateItem"]);
    expect(actionsIn("new ScanCommand({}) new BatchWriteCommand({})").map((found) => found.action).sort()).toEqual(["BatchWriteItem", "Scan"]);
  });
  it("a namespace import, a require and a dynamic import of a value or a missing module are reported, never skipped", () => {
    const root = fixture({
      "entry.ts": "import * as store from \"./store.js\";\nexport const handler = async (name: string) => { await import(name); await import(\"./gone.js\"); store.x(); require(name); };\n",
      "store.ts": "export const x = 1;\n",
    });
    const unresolved = reachableDynamoCalls("entry.ts", root).unresolved;
    expect(unresolved.some((line) => line.includes("import * as store"))).toBe(true);
    expect(unresolved.some((line) => line.includes("dynamic import or require of (a value)"))).toBe(true);
    expect(unresolved.some((line) => line.includes("dynamic import or require of ./gone.js"))).toBe(true);
  });

  it("S3-10: a dynamic import of a literal module that exists is followed whole, so the calls behind it are reached (the dispatcher's core host)", () => {
    const root = fixture({
      "entry.ts": "export const handler = async () => { const loaded = await import(\"./late.js\"); return loaded; };\n",
      "late.ts": `import { PutCommand } from "@aws-sdk/lib-dynamodb";\nexport async function write(client: { send(c: unknown): Promise<unknown> }) { await client.send(new PutCommand({ TableName: "t", Item: {} })); }\n`,
    });
    const reach = reachableDynamoCalls("entry.ts", root);
    expect(reach.unresolved).toEqual([]);
    expect(reach.calls.map((call) => call.action)).toContain("PutItem");
  });
});
