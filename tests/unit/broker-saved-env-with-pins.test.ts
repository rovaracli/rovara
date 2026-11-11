// SH25 with P1 (su-musts): a setup run's preparation carries `pins` (the heads the broker read) and never a saved image; a task's preparation carries `savedEnv` only with its approved-environment pin and never pins.
// The two fields, the two operation markers and the two held-dispatch updates must not interfere.
import { describe, expect, it, vi } from "vitest";
import type { PrepareSavedEnv } from "@agentx/cloud-contracts";
import { heldPreparationDispatch, newWorkspacePreparation } from "../../packages/broker/src/aws/broker/workspace-preparation.js";

const PINS = [{ repository: "svc", commit: "e".repeat(40) }];
vi.mock("../../packages/broker/src/aws/broker/setup-pins.js", () => ({ setupPinsOf: async () => [{ repository: "svc", commit: "e".repeat(40) }] }));

const savedEnv: PrepareSavedEnv = { repository: "rovara-env/test/oaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", digest: `sha256:${"d".repeat(64)}`, testEnvRevision: 4, environmentKey: "a".repeat(64), taskTestEnvRevision: 4 };
const PIN = { revision: 4, digest: "a".repeat(64) };
const OWNER = "owner-key-0123456789";
const REQUEST = "7c0f4b9e-1111-4222-8333-444455558888";
const projectRecord = { definition: { name: "proj-1", revision: 1, repositories: [{ name: "svc", url: "https://github.com/acme/svc.git", path: "svc", defaultBranch: "main", credentialRef: "svc-read" }], setup: [], readiness: [], orchestratorInstructions: "x" }, runtimeBinding: { deploymentMode: "ec2-ebs" } } as never;
const identity = { orgId: "org_aaaaaaaaaaaaaaaaaaaa", ownerKey: OWNER, issuer: "i", subject: "s" } as never;
const asked: unknown[] = [];
const dependencies = (table?: Map<string, unknown>) => ({
  callbackSigningKey: "signing-key", tableName: "table", repositoryGrants: { issue: () => "grant-value" },
  documentClient: { send: async (command: { input: { Key?: { pk: string; sk: string } } }) => ({ Item: command.input.Key === undefined ? undefined : table?.get(`${command.input.Key.pk}|${command.input.Key.sk}`) }) },
  savedEnvPrepare: async (input: unknown) => { asked.push(input); return { savedEnv }; },
}) as never;
type Item = { Put?: { Item?: { entityType?: string; savedEnvDigest?: string; preparePins?: unknown; invocation?: { payload?: Record<string, unknown> } } }; Update?: { UpdateExpression?: string } };
const operationOf = (items: unknown[]) => (items as Item[]).map((item) => item.Put?.Item).find((item) => item?.entityType === "OPERATION");
const payloadOf = (items: unknown[]) => (items as Item[]).map((item) => item.Put?.Item).find((item) => item?.entityType === "OUTBOX")?.invocation?.payload;

describe("a setup run and a task, side by side", () => {
  it("a setup run asks for pins and is told no saved image, even when a pin is named; a task is told the image and no pins", async () => {
    asked.length = 0;
    const setup = await newWorkspacePreparation(dependencies(), identity, projectRecord, OWNER, REQUEST, { readOnly: true, setupDraft: true, pinHeads: true, testEnvPin: PIN });
    expect(payloadOf(setup.items)).toMatchObject({ pins: PINS });
    expect(payloadOf(setup.items)).not.toHaveProperty("savedEnv");
    expect(operationOf(setup.items)).toMatchObject({ preparePins: PINS });
    expect(operationOf(setup.items)).not.toHaveProperty("savedEnvDigest");
    expect(asked).toEqual([]);

    const task = await newWorkspacePreparation(dependencies(), identity, projectRecord, OWNER, REQUEST, { testEnvPin: PIN });
    expect(payloadOf(task.items)).toMatchObject({ savedEnv });
    expect(payloadOf(task.items)).not.toHaveProperty("pins");
    expect(operationOf(task.items)).toMatchObject({ savedEnvDigest: savedEnv.digest });
    expect(operationOf(task.items)).not.toHaveProperty("preparePins");
  });

  it("a held dispatch writes the pins marker for a setup run and the digest marker for a task, never both", async () => {
    const table = new Map<string, unknown>();
    const first = await newWorkspacePreparation(dependencies(), identity, projectRecord, OWNER, REQUEST, {});
    for (const item of first.items as Item[]) {
      const put = item.Put?.Item as { pk?: string; sk?: string; entityType?: string } | undefined;
      if (put?.entityType === "WORKSPACE" || put?.entityType === "OPERATION") table.set(`${put.pk}|${put.sk}`, put);
    }
    const reading = dependencies(table);
    const updates = (items: unknown[]) => (items as Item[]).map((item) => item.Update?.UpdateExpression).filter((expression) => expression !== undefined);

    const setup = await heldPreparationDispatch(reading, projectRecord, first.workspace.id, first.operationId, OWNER, { readOnly: true, setupDraft: true, pinHeads: true, testEnvPin: PIN });
    expect(updates(setup.items)).toEqual(["SET preparePins = :pins"]);
    expect(payloadOf(setup.items)).toMatchObject({ pins: PINS });
    expect(payloadOf(setup.items)).not.toHaveProperty("savedEnv");

    const task = await heldPreparationDispatch(reading, projectRecord, first.workspace.id, first.operationId, OWNER, { testEnvPin: PIN });
    expect(updates(task.items)).toEqual(["SET savedEnvDigest = :digest"]);
    expect(payloadOf(task.items)).toMatchObject({ savedEnv });
    expect(payloadOf(task.items)).not.toHaveProperty("pins");
  });
});
