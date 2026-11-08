// Enterprise foundations P7 (wiring): a task start refuses a project whose repository lives on a code host this install has not registered, before any work is spent.
// Through the real broker handler: the stored project gets a host kind nothing registered, and the start is refused with the fixed sentence, leaving no task or workspace.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";

const start = (harness: Awaited<ReturnType<typeof createDeveloperTaskBroker>>) =>
  harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });

/** Gives every stored project definition's repositories the code host kind (what a later release writes; this release only reads it). */
function setHostKind(harness: Awaited<ReturnType<typeof createDeveloperTaskBroker>>, kind: string): number {
  let changed = 0;
  for (const item of harness.db.find((candidate) => (candidate.definition as { name?: string } | undefined)?.name === "payments")) {
    const definition = item.definition as { repositories: Array<Record<string, unknown>> };
    harness.db.set({ ...item, definition: { ...definition, repositories: definition.repositories.map((repository) => ({ ...repository, host: { kind } })) } });
    changed += 1;
  }
  return changed;
}

describe("a task start and the code hosts the install registers", () => {
  it("starts when every repository's host kind is registered, and refuses (CONFIG_INVALID, fixed sentence, nothing created) when one is not", async () => {
    const harness = await createDeveloperTaskBroker({ brokerExtra: { codeHost: { kinds: () => ["github"] } } });
    expect((await start(harness)).status).toBe(200);
    const workspacesBefore = harness.db.find((item) => item.entityType === "WORKSPACE").length;
    expect(setHostKind(harness, "examplehost")).toBeGreaterThan(0);
    const refused = await start(harness);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toContain("CONFIG_INVALID");
    expect(JSON.stringify(refused.body)).toContain("code host is not available in this install");
    expect(JSON.stringify(refused.body)).not.toContain("examplehost");
    expect(harness.db.find((item) => item.entityType === "WORKSPACE").length).toBe(workspacesBefore);
  });

  it("a registered non-GitHub kind starts, and a repository with no host is GitHub", async () => {
    const harness = await createDeveloperTaskBroker({ brokerExtra: { codeHost: { kinds: () => ["github", "examplehost"] } } });
    expect(setHostKind(harness, "examplehost")).toBeGreaterThan(0);
    expect((await start(harness)).status).toBe(200);
    const bare = await createDeveloperTaskBroker({ brokerExtra: { codeHost: { kinds: () => ["examplehost"] } } });
    const refused = await start(bare);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toContain("CONFIG_INVALID");
  });

  it("an install that builds no registry checks nothing", async () => {
    const harness = await createDeveloperTaskBroker();
    setHostKind(harness, "examplehost");
    expect((await start(harness)).status).toBe(200);
  });
});
