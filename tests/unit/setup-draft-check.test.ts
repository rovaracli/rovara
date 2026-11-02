// TE-3: the pure part of proving a setup draft's commands before they are saved (rovara-code/setup-draft-check.ts).
import { describe, expect, it } from "vitest";
import { StoredProjectDefinitionSchema } from "@agentx/contracts";
import { draftCommandLists, draftCommandsDigest, judgeDraftCheck } from "../../packages/broker/src/rovara-code/setup-draft-check.js";

const definition = StoredProjectDefinitionSchema.parse({
  name: "web", revision: 3,
  repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [{ cwd: "repo/web", executable: "make", args: ["old-setup"], timeoutSeconds: 77, env: { FOO: "1" } }],
  readiness: [{ cwd: "repo/web", executable: "make", args: ["old-test"], timeoutSeconds: 1800 }], orchestratorInstructions: "Delegate work.",
});

describe("draftCommandLists", () => {
  it("rebuilds the list the draft names as the settings save writes it, and leaves the other exactly as stored", () => {
    const lists = draftCommandLists(definition, { testCommands: ["npm test", "npm run lint -- --max-warnings 0"] });
    expect(lists.setup).toEqual(definition.setup);
    expect(lists.readiness).toEqual([
      { cwd: "repo/web", executable: "npm", args: ["test"], timeoutSeconds: 1800 },
      { cwd: "repo/web", executable: "npm", args: ["run", "lint", "--", "--max-warnings", "0"], timeoutSeconds: 1800 },
    ]);
    expect(draftCommandLists(definition, { setupCommands: ["npm ci"] }).setup).toEqual([{ cwd: "repo/web", executable: "npm", args: ["ci"], timeoutSeconds: 900 }]);
  });

  it("refuses a command the save could not read, naming the field and index and not the command", () => {
    expect(() => draftCommandLists(definition, { setupCommands: ["npm ci", "make a && make b"] })).toThrow(/setupCommands\.1: /u);
  });
});

describe("draftCommandsDigest", () => {
  it("names the exact lists: another command, timeout or env is another digest, key order is not", () => {
    const base = draftCommandLists(definition, { setupCommands: ["npm ci"] });
    const digest = draftCommandsDigest(base);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(draftCommandsDigest({ setup: base.setup.map((command) => ({ timeoutSeconds: command.timeoutSeconds, args: command.args, executable: command.executable, cwd: command.cwd })), readiness: base.readiness })).toBe(digest);
    expect(draftCommandsDigest({ ...base, setup: [{ ...base.setup[0]!, timeoutSeconds: 901 }] })).not.toBe(digest);
    expect(draftCommandsDigest({ ...base, setup: [{ ...base.setup[0]!, env: { A: "1" } }] })).not.toBe(digest);
    expect(draftCommandsDigest({ ...base, readiness: [] })).not.toBe(digest);
  });
});

describe("judgeDraftCheck", () => {
  const lists = draftCommandLists(definition, { setupCommands: ["npm ci"] });
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  const state = (over: Record<string, unknown> = {}, status = "ready") => ({
    check: { workspaceId: "w", revision: 3, startedAt: "2026-11-02T11:00:00.000Z", ...lists, ...over },
    setup: { status, checkedRevision: 3, checkedAt: "2026-11-02T11:00:00.000Z", ...(status === "failed" ? { failedStep: "setup: npm ci - exited 1" } : {}) },
  }) as never;
  const judge = (st: ReturnType<typeof state>, mine?: { workspaceId: string }) => judgeDraftCheck({ state: st, lists, revision: 3, nowMs: now, mine }).kind;

  it("passes only a ready, recent check of exactly these lists at this revision", () => {
    expect(judge(state())).toBe("passed");
    expect(judge(state({ revision: 2 }))).toBe("start");
    expect(judge(state({ startedAt: "2026-10-20T11:00:00.000Z" }))).toBe("start");
    expect(judge(state({ startedAt: "2026-11-02T13:00:00.000Z" }))).toBe("start");
    expect(judge(state({ setup: [] }))).toBe("start");
    expect(judge(state({ readiness: [{ ...definition.readiness[0]!, env: { X: "1" } }] }))).toBe("start");
    expect(judge({ check: undefined, setup: { status: "unchecked" } } as never)).toBe("start");
  });

  it("a check this request started that cannot be used reads as lost; one that failed reads as failed; one that runs is waited for by anybody", () => {
    expect(judge(state({ setup: [] }), { workspaceId: "w" })).toBe("lost");
    expect(judge(state({}, "failed"), { workspaceId: "w" })).toBe("failed");
    expect(judge(state({}, "failed"))).toBe("start");
    expect(judge(state({}, "checking"))).toBe("checking");
    expect(judge(state({}, "checking"), { workspaceId: "w" })).toBe("checking");
  });
});
