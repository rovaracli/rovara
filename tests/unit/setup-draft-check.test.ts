// TE-3: the pure part of proving a setup draft's commands before they are saved (rovara-code/setup-draft-check.ts).
import { describe, expect, it } from "vitest";
import { StoredProjectDefinitionSchema } from "@rovara-code/contracts";
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

describe("draftCommandLists keeps each unchanged command's own options", () => {
  const three = StoredProjectDefinitionSchema.parse({
    name: "web", revision: 3,
    repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
    setup: [
      { cwd: "repo/web", executable: "make", args: ["one"], timeoutSeconds: 111, env: { A: "1" } },
      { cwd: "repo/web", executable: "make", args: ["two"], timeoutSeconds: 222, env: { B: "2" } },
      { cwd: "repo/web", executable: "make", args: ["three"], timeoutSeconds: 333 },
    ],
    readiness: [{ cwd: "repo/web", executable: "make", args: ["old-test"], timeoutSeconds: 1800 }], orchestratorInstructions: "Delegate work.",
  });
  it("edit one of three: the other two keep their timeout and env, the edited one takes the defaults", () => {
    const lists = draftCommandLists(three, { setupCommands: ["make one", "make two-changed", "make three"] });
    expect(lists.setup[0]).toEqual(three.setup[0]);
    expect(lists.setup[1]).toEqual({ cwd: "repo/web", executable: "make", args: ["two-changed"], timeoutSeconds: 900 });
    expect(lists.setup[2]).toEqual(three.setup[2]);
  });
  it("reorder: each command keeps its own options, and the list still differs from the stored one (so it is proved)", () => {
    const lists = draftCommandLists(three, { setupCommands: ["make three", "make one", "make two"] });
    expect(lists.setup).toEqual([three.setup[2], three.setup[0], three.setup[1]]);
    expect(draftCommandsDigest(lists)).not.toBe(draftCommandsDigest({ setup: [...three.setup], readiness: [...three.readiness] }));
  });
  it("delete: the rest keep their options, and the list differs from the stored one", () => {
    const lists = draftCommandLists(three, { setupCommands: ["make one", "make three"] });
    expect(lists.setup).toEqual([three.setup[0], three.setup[2]]);
    expect(draftCommandsDigest(lists)).not.toBe(draftCommandsDigest({ setup: [...three.setup], readiness: [...three.readiness] }));
  });
  it("the same lines, spelled with other spacing or quotes, are the stored commands; a repeated line uses each stored command once", () => {
    expect(draftCommandLists(three, { setupCommands: ["make   'one'", "make two", "make three"] }).setup).toEqual([...three.setup]);
    const twice = draftCommandLists(three, { setupCommands: ["make one", "make one"] }).setup;
    expect(twice[0]).toEqual(three.setup[0]);
    expect(twice[1]).toEqual({ cwd: "repo/web", executable: "make", args: ["one"], timeoutSeconds: 900 });
  });
  it("a line is never given another command's env", () => {
    const lists = draftCommandLists(three, { setupCommands: ["make two --flag"] });
    expect(lists.setup).toEqual([{ cwd: "repo/web", executable: "make", args: ["two", "--flag"], timeoutSeconds: 900 }]);
  });
});

describe("a dev container in the batch", () => {
  it("is part of the lists as the save stores it (the repository by its project name) and of the digest", () => {
    const plain = draftCommandLists(definition, { setupCommands: ["npm ci"] });
    const withContainer = draftCommandLists(definition, { setupCommands: ["npm ci"], devcontainer: { repository: "WEB", configPath: ".devcontainer/devcontainer.json" } });
    expect(withContainer.devcontainer).toEqual({ repository: "web", configPath: ".devcontainer/devcontainer.json" });
    expect(withContainer.setup).toEqual(plain.setup);
    expect(draftCommandsDigest(withContainer)).not.toBe(draftCommandsDigest(plain));
    expect(draftCommandsDigest(withContainer)).not.toBe(draftCommandsDigest({ ...withContainer, devcontainer: { repository: "web", configPath: ".devcontainer.json" } }));
    expect(() => draftCommandLists(definition, { setupCommands: ["npm ci"], devcontainer: { repository: "nope" } })).toThrow(/devcontainer\.repository/u);
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
    // Another request's press shows the failure; only "check again" runs a new check.
    expect(judge(state({}, "failed"))).toBe("failed");
    expect(judgeDraftCheck({ state: state({}, "failed"), lists, revision: 3, nowMs: now, mine: undefined, again: true }).kind).toBe("start");
    expect(judgeDraftCheck({ state: state({}, "failed"), lists, revision: 3, nowMs: now, mine: { workspaceId: "w" }, again: true }).kind).toBe("failed");
    expect(judge(state({}, "checking"))).toBe("checking");
    expect(judge(state({}, "checking"), { workspaceId: "w" })).toBe("checking");
  });
});
