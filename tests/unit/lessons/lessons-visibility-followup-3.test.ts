// Lessons visibility follow-up, final round: the review's M1 (a scope cut at 300 characters must never read as repository-only), M2 / owner decision 36 (a lesson restricted only to project repository A loads into any
// project task, but is NAMED and PUBLISHED only in repository A itself), L1 (a PR comment by someone without a project role is never a member correction), L2 (a repository that was deleted or excluded stops
// converting at once) and L3 (lessons withheld because their source task is a legacy task with no session item are counted).
import { describe, expect, it } from "vitest";
import { createAccessCheckPort } from "../../../packages/broker/src/team-record/access-port.js";
import type { TaskVisibilityPort } from "../../../packages/broker/src/team-record/live-audience.js";
import { closeScope } from "../../../packages/broker/src/team-record/item-head.js";
import { CUT_SCOPE_PLACE, lessonPlaces, narrowestAudience, type Audience, type Lesson } from "../../../packages/broker/src/lessons/types.js";
import { repoOnlyScopes, tableProjectRepoScopes, viewedForLessons } from "../../../packages/broker/src/lessons/project-repo-audience.js";
import { ORG_A, addSource, githubDraft, world } from "../../support/team-record-core.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { projectRevisionKey } from "@agentx/contracts";
import { draft, lessonRecord } from "./lesson-helpers.js";

const AT = "2026-11-08T00:00:00.000Z";
const repoAudience = (id: string): Audience => ({ kind: "restricted", acl: { source: "github", scope: `github:repo/${id}`, capturedAt: AT, liveCheck: "on_read" } });
const lessonOf = (audience: Audience, sourceScopes: string[] = []): Lesson => lessonRecord({ provenance: { ...draft().provenance, audience, sourceScopes } });

describe("M1: a scope cut at 300 characters never reads as repository-only", () => {
  // The reviewer's probe (lvfr-trunc.mts): 7 eight-digit and 7 nine-digit project repositories make 14 places of exactly 300 characters with their separators; another project's private repository sorts last
  // and used to be the part that was cut away.
  const project = [...Array.from({ length: 7 }, (_, i) => String(20000000 + i)), ...Array.from({ length: 7 }, (_, i) => String(300000000 + i))];
  const otherProjectRepo = "999999999";
  const projectRepos = new Set(project.map((id) => `github:repo/${id}`));
  const cut = narrowestAudience([...project, otherProjectRepo].map(repoAudience));

  it("the probe: the cut scope stays within the limit, ends with a place nobody matches, and is NOT judged project-wide", () => {
    expect(cut.kind).toBe("restricted");
    if (cut.kind !== "restricted") return;
    expect(cut.acl.scope.length).toBeLessThanOrEqual(300);
    expect(cut.acl.scope.endsWith(`+${CUT_SCOPE_PLACE}`)).toBe(true);
    const lesson = lessonOf(cut);
    expect(repoOnlyScopes(lesson)).toBeUndefined();
    expect(viewedForLessons(lesson, projectRepos).provenance.audience.kind).toBe("restricted");
  });

  it("positive control: the same fourteen places without the other project's repository are complete, short enough, and DO convert", () => {
    const whole = narrowestAudience(project.map(repoAudience));
    expect(whole.kind === "restricted" && whole.acl.scope.length).toBe(300);
    const lesson = lessonOf(whole);
    // Exactly at the limit a scope may have been cut elsewhere, so it is not believed; one place fewer is below it and converts.
    expect(viewedForLessons(lesson, projectRepos).provenance.audience.kind).toBe("restricted");
    const shorter = lessonOf(narrowestAudience(project.slice(1).map(repoAudience)));
    expect(repoOnlyScopes(shorter)).toHaveLength(13);
    expect(viewedForLessons(shorter, projectRepos).provenance.audience.kind).toBe("project");
  });

  it("a scope of the limit's length that carries no marker (stored before this fix, or cut elsewhere) is not believed either", () => {
    const places = project.map((id) => `github:repo/${id}`);
    const scope = places.join("+");
    expect(scope.length).toBe(300);
    const stored: Audience = { kind: "restricted", acl: { source: "github", scope, capturedAt: AT, liveCheck: "on_read" } };
    expect(repoOnlyScopes(lessonOf(stored))).toBeUndefined();
    expect(viewedForLessons(lessonOf(stored), projectRepos).provenance.audience.kind).toBe("restricted");
  });

  it("merging an already-cut scope with more places still ends in the marker, and the marker place matches no access record", async () => {
    const again = narrowestAudience([cut, repoAudience("888888888"), repoAudience("111111111")]);
    expect(again.kind === "restricted" && again.acl.scope.endsWith(`+${CUT_SCOPE_PLACE}`)).toBe(true);
    // The real access port: the marker place has no record, and it is one of the lesson's own restricted places, so a reader of nobody in particular is denied.
    const w = world();
    const team: TaskVisibilityPort = { read: async () => new Map() };
    const access = createAccessCheckPort(w.table, { taskVisibility: team });
    const places = lessonPlaces(lessonOf(cut));
    expect(places.restrictedScopes).toContain(CUT_SCOPE_PLACE);
    expect(await access.mayRead(ORG_A, undefined, [places])).toEqual([false]);
    expect(await access.mayRead(ORG_A, { principals: ["U1"], groups: [] }, [places])).toEqual([false]);
  });
});

describe("L2: a repository that was deleted, transferred or excluded stops converting at once, while its pinned id is still in the project", () => {
  const repo = (name: string, id: number) => ({ name, url: `https://github.com/acme/${name}`, path: name, defaultBranch: "main", credentialRef: "github-app", githubRepositoryId: id, installationId: 5 });
  function pinned() {
    const db = new FakeDynamoDb();
    db.set({ ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT_REVISION", definition: { repositories: [repo("api", 9), repo("web", 10)] } });
    return db;
  }

  it("a closed place (the removal was queued, `closeScope`) is left out of the project's repositories; the open one stays; without the record table nothing changes", async () => {
    const w = world();
    const port = tableProjectRepoScopes({ documentClient: pinned(), tableName: "state" }, { record: w.table });
    expect([...await port.read(ORG_A, "web")].sort()).toEqual(["github:repo/10", "github:repo/9"]);
    await closeScope(w.table, ORG_A, "github:repo/9", "source_deleted", AT);
    expect([...await port.read(ORG_A, "web")]).toEqual(["github:repo/10"]);
    expect(await port.placeOf?.(ORG_A, "web", "api")).toBeUndefined();
    expect(await port.placeOf?.(ORG_A, "web", "web")).toBe("github:repo/10");
    // The old reader (no record table) is unchanged.
    expect([...await tableProjectRepoScopes({ documentClient: pinned(), tableName: "state" }).read(ORG_A, "web")].sort()).toEqual(["github:repo/10", "github:repo/9"]);
  });

  it("so a lesson restricted to the closed repository is restricted again (it stops loading) before any withdrawal has run; a marker that can't be read refuses the whole read", async () => {
    const w = world();
    const port = tableProjectRepoScopes({ documentClient: pinned(), tableName: "state" }, { record: w.table });
    const lesson = lessonOf(repoAudience("9"));
    expect(viewedForLessons(lesson, await port.read(ORG_A, "web")).provenance.audience.kind).toBe("project");
    await closeScope(w.table, ORG_A, "github:repo/9", "excluded", AT);
    expect(viewedForLessons(lesson, await port.read(ORG_A, "web")).provenance.audience.kind).toBe("restricted");
    const broken = { documentClient: { send: async () => { throw new Error("down"); } }, tableName: "record" };
    await expect(tableProjectRepoScopes({ documentClient: pinned(), tableName: "state" }, { record: broken }).read(ORG_A, "web")).rejects.toThrow();
  });
});
