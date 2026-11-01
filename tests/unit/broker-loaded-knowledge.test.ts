import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOADED_KNOWLEDGE_EVENT_FIELD, LoadedKnowledgeManifestSchema, loadedKnowledgeOfProgress, type LoadedKnowledgeManifest } from "@agentx/contracts";

const access = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock("../../packages/broker/src/developer/task-access.js", () => ({
  resolveTaskAccess: async (_deps: unknown, caller: { developerId: string }, taskId: string) => {
    if (!access.allowed.has(`${caller.developerId}:${taskId}`)) throw new Error("TASK_NOT_FOUND");
    return { task: { taskId, orgId: "org-1", project: "payments" }, role: "viewer", ownerActorIds: [] };
  },
}));
const { listLoadedKnowledge, recordLoadedKnowledgeFromProgress, routeLoadedKnowledge } = await import("../../packages/broker/src/developer/loaded-knowledge.js");

const TASK = "11111111-2222-3333-4444-555555555555";
const COMMIT = "c".repeat(40);
const META_COMMIT = "d".repeat(40);
const RULE_TEXT = "# Never log customer data\nRULE BODY\n";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const manifest = (stage: LoadedKnowledgeManifest["stage"] = "review"): LoadedKnowledgeManifest => ({
  schemaVersion: 1, stage,
  metaRepo: { name: "service-meta", knowledgeCommit: META_COMMIT },
  repos: [{ name: "engine", commit: COMMIT, readAt: "base" }],
  items: [
    { layer: "meta", repo: "service-meta", path: ".kiro/steering/product.md", scopeDir: "", format: "kiro_steering", activation: "always", bytes: 30, digest: sha("x"), fileDigest: sha(RULE_TEXT), readAt: "knowledgeCommit", status: "loaded", why: { kind: "always" } },
    { layer: "repo", repo: "engine", path: "AGENTS.md", scopeDir: "", format: "agents_md", bytes: 5, digest: sha("y"), fileDigest: sha(RULE_TEXT), readAt: "base", status: "loaded", why: { kind: "always" } },
    { layer: "repo", repo: "engine", path: ".cursor/rules/ui.mdc", scopeDir: "", format: "cursor_mdc", bytes: 0, status: "skipped", reason: "not_matched" },
    { layer: "meta", repo: "service-meta", path: ".kiro/steering/api.md", scopeDir: "", format: "kiro_steering", bytes: 3, fileDigest: sha(RULE_TEXT), status: "available" },
  ],
  omitted: { skipped: 0, available: 0 }, skills: [], skippedSkills: [], sources: [],
  budget: { alwaysOnBytes: 35, alwaysOnLimitBytes: 131072, additionsBytes: 0, additionsLimitBytes: 131072, skipped: 0 },
});

function table() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    documentClient: {
      send: async (command: { constructor: { name: string }; input: { Item: Record<string, unknown>; ExpressionAttributeValues: Record<string, string> } }) => {
        const name = command.constructor.name;
        if (name === "PutCommand") { rows.set(`${String(command.input.Item.pk)}|${String(command.input.Item.sk)}`, command.input.Item); return {}; }
        if (name === "QueryCommand") {
          const pk = command.input.ExpressionAttributeValues[":pk"]; const prefix = command.input.ExpressionAttributeValues[":prefix"];
          return { Items: [...rows.values()].filter((row) => row.pk === pk && String(row.sk).startsWith(String(prefix))) };
        }
        if (name === "GetCommand") return { Item: { taskId: TASK, orgId: "org-1", project: "payments" } };
        throw new Error(name);
      },
    },
    tableName: "state",
  };
}
const caller = (developerId = "dev-1", orgId = "org-1") => ({ developerId, orgId }) as never;

describe("loaded knowledge store", () => {
  beforeEach(() => { access.allowed = new Set([`dev-1:${TASK}`]); });

  it("stores a record from a progress payload, keeps the latest per stage and operation, and holds no rule text", async () => {
    const t = table();
    const deps = { ...t, now: () => Date.UTC(2026, 9, 30) } as never;
    expect(await recordLoadedKnowledgeFromProgress(deps, { taskId: TASK, operationId: "op1", payload: { [LOADED_KNOWLEDGE_EVENT_FIELD]: manifest("review") } })).toBe(true);
    await recordLoadedKnowledgeFromProgress(deps, { taskId: TASK, operationId: "op1", payload: { [LOADED_KNOWLEDGE_EVENT_FIELD]: manifest("review") } });
    await recordLoadedKnowledgeFromProgress(deps, { taskId: TASK, operationId: "op1", payload: { [LOADED_KNOWLEDGE_EVENT_FIELD]: manifest("plan") } });
    expect(t.rows.size).toBe(2);
    expect(JSON.stringify([...t.rows.values()])).not.toContain("RULE BODY");
    const listed = await listLoadedKnowledge(t, TASK);
    expect(listed.map((entry) => entry.stage).toSorted()).toEqual(["plan", "review"]);
  });

  it("drops a malformed or oversized record whole, and a bad operation id", async () => {
    const t = table();
    const deps = { ...t } as never;
    const withText = { ...manifest(), items: [{ ...manifest().items[0], text: "RULE BODY" }] };
    expect(LoadedKnowledgeManifestSchema.safeParse(withText).success).toBe(false);
    expect(await recordLoadedKnowledgeFromProgress(deps, { taskId: TASK, operationId: "op1", payload: { [LOADED_KNOWLEDGE_EVENT_FIELD]: withText } })).toBe(false);
    expect(await recordLoadedKnowledgeFromProgress(deps, { taskId: TASK, operationId: "../x", payload: { [LOADED_KNOWLEDGE_EVENT_FIELD]: manifest() } })).toBe(false);
    expect(await recordLoadedKnowledgeFromProgress(deps, { taskId: TASK, operationId: "op1", payload: { message: "hi" } })).toBe(false);
    expect(loadedKnowledgeOfProgress(null)).toBeUndefined();
    expect(t.rows.size).toBe(0);
  });

  it("a failed write is logged without detail and never throws", async () => {
    const logs: unknown[] = [];
    const deps = { documentClient: { send: async () => { throw new Error("DDB SECRET"); } }, tableName: "t", log: (entry: unknown) => logs.push(entry) } as never;
    expect(await recordLoadedKnowledgeFromProgress(deps, { taskId: TASK, operationId: "op1", payload: { [LOADED_KNOWLEDGE_EVENT_FIELD]: manifest() } })).toBe(false);
    expect(JSON.stringify(logs)).not.toContain("SECRET");
  });
});

describe("loaded knowledge routes", () => {
  beforeEach(() => { access.allowed = new Set([`dev-1:${TASK}`]); });
  const base = async () => {
    const t = table();
    await recordLoadedKnowledgeFromProgress({ ...t, now: () => Date.UTC(2026, 9, 30) }, { taskId: TASK, operationId: "op1", payload: { [LOADED_KNOWLEDGE_EVENT_FIELD]: manifest("review") } });
    return t;
  };
  const route = (deps: object, path: string, who = caller()) => routeLoadedKnowledge({ access: {}, ...deps } as never, who, { method: "GET", path });

  it("ignores other requests", async () => {
    expect(await route({}, "/v1/app/tasks/x/other")).toBeUndefined();
    expect(await routeLoadedKnowledge({ access: {} } as never, caller(), { method: "POST", path: `/v1/app/tasks/${TASK}/loaded-knowledge` })).toBeUndefined();
  });

  it("lists a task's records for someone who can see the task, and reads as no task for anyone else", async () => {
    const t = await base();
    const answer = await route(t, `/v1/app/tasks/${TASK}/loaded-knowledge`) as { stages: unknown[] };
    expect(answer.stages).toHaveLength(1);
    await expect(route(t, `/v1/app/tasks/${TASK}/loaded-knowledge`, caller("dev-2"))).rejects.toThrow("TASK_NOT_FOUND");
  });

  it("lets an Auditor of the same org read the records but not the text, and nobody from another org", async () => {
    const t = await base();
    const auditor = { isAuditor: async () => true, canReadRepository: async () => true, readRuleFile: async () => RULE_TEXT };
    expect(((await route({ ...t, ...auditor }, `/v1/app/tasks/${TASK}/loaded-knowledge`, caller("aud"))) as { stages: unknown[] }).stages).toHaveLength(1);
    await expect(route({ ...t, ...auditor }, `/v1/app/tasks/${TASK}/loaded-knowledge/op1/review/items/0/text`, caller("aud"))).rejects.toThrow(/Auditors/u);
    await expect(route({ ...t, ...auditor }, `/v1/app/tasks/${TASK}/loaded-knowledge`, caller("aud", "org-2"))).rejects.toThrow();
  });

  const text = (deps: object, index: number, who = caller()) => route(deps, `/v1/app/tasks/${TASK}/loaded-knowledge/op1/review/items/${index}/text`, who);

  it("serves a listed file's text from the pinned commit to a viewer who can read the repository", async () => {
    const t = await base();
    const reads: unknown[] = [];
    const deps = { ...t, canReadRepository: async () => true, readRuleFile: async (input: unknown) => { reads.push(input); return RULE_TEXT; } };
    expect(await text(deps, 0)).toMatchObject({ available: true, repo: "service-meta", path: ".kiro/steering/product.md", commit: META_COMMIT, text: RULE_TEXT });
    expect(await text(deps, 1)).toMatchObject({ available: true, commit: COMMIT });
    expect(reads[0]).toMatchObject({ commit: META_COMMIT, project: "payments", repo: "service-meta", path: ".kiro/steering/product.md" });
  });

  it("refuses text to a viewer who cannot read the repository, and does not read the file at all", async () => {
    const t = await base();
    const readRuleFile = vi.fn(async () => RULE_TEXT);
    await expect(text({ ...t, canReadRepository: async () => false, readRuleFile }, 0)).rejects.toThrow(/can't read this repository/u);
    await expect(text({ ...t, canReadRepository: async () => { throw new Error("down"); }, readRuleFile }, 0)).rejects.toThrow(/can't read this repository/u);
    expect(readRuleFile).not.toHaveBeenCalled();
  });

  it("serves only listed, loaded or skipped files: not an out-of-range index, an available-only item, or text with no reader configured", async () => {
    const t = await base();
    const deps = { ...t, canReadRepository: async () => true, readRuleFile: async () => RULE_TEXT };
    await expect(text(deps, 9)).rejects.toThrow("TASK_NOT_FOUND");
    await expect(text(deps, 3)).rejects.toThrow("TASK_NOT_FOUND");
    await expect(text(deps, 2)).rejects.toThrow("TASK_NOT_FOUND");
    await expect(text(t, 0)).rejects.toThrow(/not available here/u);
  });

  it("does not show a file that no longer hashes to the recorded digest, and says why", async () => {
    const t = await base();
    const answer = await text({ ...t, canReadRepository: async () => true, readRuleFile: async () => "SOMETHING ELSE" }, 0);
    expect(answer).toEqual({ available: false, reason: "changed" });
    expect(await text({ ...t, canReadRepository: async () => true, readRuleFile: async () => undefined }, 0)).toEqual({ available: false, reason: "unreadable" });
  });
});

describe("loaded knowledge: reviewers and defence in depth", () => {
  beforeEach(() => { access.allowed = new Set([`dev-1:${TASK}`]); });
  it("keeps one record per reviewer, and serves each reviewer's text by its own path", async () => {
    const t = table();
    const deps = { ...t, now: () => Date.UTC(2026, 9, 30) } as never;
    await recordLoadedKnowledgeFromProgress(deps, { taskId: TASK, operationId: "op1", payload: { [LOADED_KNOWLEDGE_EVENT_FIELD]: { ...manifest("review"), role: "CRITIC" } } });
    await recordLoadedKnowledgeFromProgress(deps, { taskId: TASK, operationId: "op1", payload: { [LOADED_KNOWLEDGE_EVENT_FIELD]: { ...manifest("review"), role: "SECURITY" } } });
    expect(t.rows.size).toBe(2);
    expect((await listLoadedKnowledge(t as never, TASK)).map((entry) => entry.role).toSorted()).toEqual(["CRITIC", "SECURITY"]);
    const reads = { ...t, canReadRepository: async () => true, readRuleFile: async () => RULE_TEXT };
    const text = (segment: string) => routeLoadedKnowledge({ access: {}, ...reads } as never, caller(), { method: "GET", path: `/v1/app/tasks/${TASK}/loaded-knowledge/op1/${segment}/items/0/text` });
    expect(await text("review.SECURITY")).toMatchObject({ available: true });
    await expect(text("review")).rejects.toThrow("TASK_NOT_FOUND");
    await expect(text("review.NOBODY")).rejects.toThrow("TASK_NOT_FOUND");
  });

  it("refuses a path or repository the record should not name before any reader is called", async () => {
    const t = table();
    const forged = manifest("review");
    forged.items[0] = { ...forged.items[0]!, path: "../../secrets.md" };
    forged.items[1] = { ...forged.items[1]!, repo: "another-project-repo" };
    await recordLoadedKnowledgeFromProgress({ ...t, now: () => Date.UTC(2026, 9, 30) }, { taskId: TASK, operationId: "op1", payload: { [LOADED_KNOWLEDGE_EVENT_FIELD]: forged } });
    const readRuleFile = vi.fn(async () => RULE_TEXT);
    const deps = { access: {}, ...t, canReadRepository: async () => true, readRuleFile };
    for (const index of [0, 1]) {
      await expect(routeLoadedKnowledge(deps as never, caller(), { method: "GET", path: `/v1/app/tasks/${TASK}/loaded-knowledge/op1/review/items/${index}/text` })).rejects.toThrow("TASK_NOT_FOUND");
    }
    expect(readRuleFile).not.toHaveBeenCalled();
  });
});
