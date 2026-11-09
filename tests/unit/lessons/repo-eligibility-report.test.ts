// Lessons in the repo, lane R1: the measurement before the file pass. Counts per project and repository, the reasons for "not", the share of reflections whose inputs were all repository-visible; counts only, nothing that names a
// lesson or a person; and the operator script that feeds it from the lesson heads, read-only, with fakes (no AWS).
import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { NO_REPO_BUCKET, repoEligibilityReport, reposNamedBy, type RepoEligibilityReport } from "../../../packages/broker/src/lessons/repo-eligibility-report.js";
import type { Audience, Lesson } from "../../../packages/broker/src/lessons/types.js";
import { formatReport, main, parseArgs, readLessonHeads, readOnlyClient, type MainDependencies, type ReportClient } from "../../../scripts/lessons-repo-eligibility-report.js";
import { lessonRecord } from "./lesson-helpers.js";

const A = "github:repo/1001";
const B = "github:repo/2002";
const SINCE = 1_000;
const readersOf = (place: string): Audience => ({ kind: "restricted", acl: { source: "github", scope: place, capturedAt: "t", liveCheck: "on_read" } });
const stable = { state: "stable" as const, startedAt: 1, stableAt: 2 };

/** A lesson with unmistakable secrets in every field the report must never carry. */
function lesson(id: string, over: Partial<Lesson> = {}, prov: Record<string, unknown> = {}): Lesson {
  const base = lessonRecord({ id: `les_${id}`, title: `TITLE-${id}`, description: `DESC-${id}`, body: `BODY-${id}`, trial: stable, createdAt: 5_000, ...over });
  return { ...base, provenance: { ...base.provenance, authors: [`author-of-${id}`], sources: [`member:src-${id}`], inputSources: [`member:src-${id}`, "slack:CHANNEL-SECRET"], reflectorRun: `run-${id}`, audience: { kind: "project" }, ...prov } };
}
const row = (l: Lesson, workspaceId = "org_aaaaaaaaaaaaaaaaaaaa", project = "proj-1") => ({ workspaceId, project, lesson: l });

describe("repoEligibilityReport: counts per project and repository", () => {
  const rows = [
    row(lesson("e1", {}, { repoOnly: { place: A }, sourceScopes: [A] })),
    row(lesson("e2", {}, { repoOnly: { place: A }, audience: readersOf(A), sourceScopes: [A] })),
    row(lesson("trial1", { trial: { state: "trial", startedAt: 1 } }, { repoOnly: { place: A }, sourceScopes: [A] })),
    row(lesson("slack1", {}, { repoBlockCodes: ["other_place", "typed_in_rovara"], sourceScopes: [A] })),
    row(lesson("old1", {}, { sourceScopes: [B] })),
    row(lesson("none1", {}, { repoBlockCodes: ["task_inputs_unproved"] })),
    row(lesson("retired1", { status: "retired" }, { repoOnly: { place: A }, sourceScopes: [A] })),
    row(lesson("other-project", {}, { repoOnly: { place: B }, sourceScopes: [B] }), "org_aaaaaaaaaaaaaaaaaaaa", "proj-2"),
  ];
  const report = repoEligibilityReport(rows, { sinceMs: SINCE });
  const project = (name: string) => report.projects.find((p) => p.project === name)!;
  const repo = (p: string, r: string) => project(p).repos.find((x) => x.repo === r)!;
  const reasons = (p: string, r: string) => Object.fromEntries(repo(p, r).topReasons.map((x) => [x.reason, x.count]));

  it("counts only active lessons, per project, each once", () => {
    expect(report).toMatchObject({ lessonsRead: 8, active: 7, eligibleForAny: 3, rosterChecked: false });
    expect(project("proj-1")).toMatchObject({ active: 6, eligibleForAny: 2 });
    expect(project("proj-2")).toMatchObject({ active: 1, eligibleForAny: 1 });
  });

  it("counts per repository: eligible versus not, and the reasons for not", () => {
    expect(repo("proj-1", A)).toMatchObject({ active: 4, eligible: 2, notEligible: 2 });
    expect(reasons("proj-1", A)).toEqual({ "file:on_trial": 1, "file:not_repo_only": 1, "input:other_place": 1, "input:typed_in_rovara": 1 });
    expect(repo("proj-1", B)).toMatchObject({ active: 1, eligible: 0 });
    expect(reasons("proj-1", B)).toEqual({ "file:not_repo_only": 1, "input:predates_field": 1 });
    expect(repo("proj-1", NO_REPO_BUCKET)).toMatchObject({ active: 1, eligible: 0 });
    expect(reasons("proj-1", NO_REPO_BUCKET)).toEqual({ "file:no_repo_named": 1, "input:task_inputs_unproved": 1 });
    expect(repo("proj-2", B)).toMatchObject({ active: 1, eligible: 1, notEligible: 0 });
  });

  it("lists the most common reasons across everything, most common first, bounded", () => {
    expect(report.topReasons.length).toBeLessThanOrEqual(5);
    expect(report.topReasons[0]!.count).toBeGreaterThanOrEqual(report.topReasons.at(-1)!.count);
    const limited = repoEligibilityReport(rows, { sinceMs: SINCE, topReasons: 2 });
    expect(limited.topReasons).toHaveLength(2);
  });

  it("carries no lesson text, no lesson id, no person, no source key or channel: positive control that those strings are in the input", () => {
    const text = JSON.stringify(report);
    const input = JSON.stringify(rows);
    for (const secret of ["TITLE-e1", "BODY-e1", "DESC-e1", "les_e1", "les_slack1", "author-of-e1", "src-e1", "CHANNEL-SECRET", "run-e1"]) {
      expect(input, `control ${secret}`).toContain(secret);
      expect(text, secret).not.toContain(secret);
    }
    // The formatted output holds the same counts and nothing more.
    const printed = formatReport(report, 0, "table, region");
    for (const secret of ["TITLE-e1", "BODY-e1", "author-of-e1", "CHANNEL-SECRET", "run-e1"]) expect(printed).not.toContain(secret);
    // The only project and repository names are the ones it was asked about.
    expect(text).toContain(A);
    expect(text).toContain("proj-1");
  });

  it("an empty table gives an empty report, not an error", () => {
    expect(repoEligibilityReport([], { sinceMs: SINCE })).toMatchObject({ lessonsRead: 0, active: 0, eligibleForAny: 0, projects: [], recentReflections: 0 });
  });

  it("names the repositories a lesson names: repoOnly place, repository source scopes, the repository its audience is restricted to", () => {
    expect(reposNamedBy(lesson("x", {}, { repoOnly: { place: A }, sourceScopes: [A, B, "slack:channel/C1"], audience: readersOf(B) }))).toEqual([A, B]);
    expect(reposNamedBy(lesson("y"))).toEqual([]);
  });
});

describe("repoEligibilityReport: the share of recent reflections whose inputs were all repository-visible", () => {
  it("counts distinct reflector runs since the cutoff; a run is visible only if none of its lessons says otherwise", () => {
    const mk = (id: string, run: string, createdAt: number, prov: Record<string, unknown>) => row(lesson(id, { createdAt }, { reflectorRun: run, ...prov }));
    const report = repoEligibilityReport([
      mk("a1", "run-A", 5_000, { repoOnly: { place: A } }),
      mk("a2", "run-A", 5_000, { repoOnly: { place: A } }),
      mk("b1", "run-B", 5_000, { repoBlockCodes: ["other_place"] }),
      mk("c1", "run-C", 5_000, { repoOnly: { place: A } }),
      mk("c2", "run-C", 5_000, { repoBlockCodes: ["typed_in_rovara"] }),
      mk("d1", "run-D", 5_000, {}),
      mk("old", "run-OLD", 500, { repoOnly: { place: A } }),
    ], { sinceMs: SINCE });
    expect(report.recentReflections).toBe(4);
    expect(report.recentRepoVisible).toBe(1);
    expect(report.projects[0]).toMatchObject({ recentReflections: 4, recentRepoVisible: 1 });
  });
});

type Row = Record<string, unknown>;
/** An in-memory table that answers the one Scan this script sends (entityType equality, paged), records every command, and refuses to be written. */
function fakeTable(items: Row[], pageSize = 2) {
  const commands: string[] = [];
  const client: ReportClient = {
    async send(command) {
      commands.push(command.constructor.name);
      if (!(command instanceof ScanCommand)) throw new Error("only Scan");
      const input = command.input;
      const start = input.ExclusiveStartKey === undefined ? 0 : Number(input.ExclusiveStartKey.at) + 1;
      const slice = items.slice(start, start + Math.min(pageSize, input.Limit ?? pageSize));
      const wanted: unknown = input.ExpressionAttributeValues?.[":lesson"];
      const matching = slice.filter((item) => item.entityType === wanted);
      const last = start + slice.length - 1;
      return { Items: matching, ...(last + 1 < items.length ? { LastEvaluatedKey: { at: last } } : {}) };
    },
  };
  return { client, commands };
}
const head = (l: Lesson): Row => ({ pk: "ORG#x#PROJECT#p", sk: `LESSON#${l.id}`, entityType: "LESSON", latest: 1, rev: 0, ...JSON.parse(JSON.stringify(l)) as Row });

describe("the operator script", () => {
  const lessons = [
    lesson("s1", {}, { repoOnly: { place: A }, sourceScopes: [A] }),
    lesson("s2", {}, { repoBlockCodes: ["other_place"], sourceScopes: [A] }),
    lesson("s3", { status: "retired" }, { sourceScopes: [A] }),
  ];
  const items: Row[] = [head(lessons[0]!), { pk: "p", sk: "LESSONSET", entityType: "LESSONSET", members: {} }, head(lessons[1]!), { ...head(lessons[2]!), status: "not-a-status", id: "les_bad1" }, { pk: "p", sk: "COUNTER", entityType: "COUNTER" }, head(lessons[2]!)];

  it("parses its arguments: exactly one table source, a region from a flag or the guard's environment, no profile, no default region", () => {
    expect(parseArgs(["--env", "staging", "--region", "us-west-2"])).toMatchObject({ table: "agentx-staging-team-record", region: "us-west-2", json: false, sinceDays: 14 });
    expect(parseArgs(["--table", "my-table", "--json", "--since-days", "7", "--pause-ms", "0"], { AWS_REGION: "us-west-2" })).toMatchObject({ table: "my-table", region: "us-west-2", json: true, sinceDays: 7, pauseMs: 0 });
    for (const bad of [[], ["--env", "a", "--table", "b"], ["--env", "staging"], ["--env", "Bad Name", "--region", "us-west-2"], ["--table", "x", "--region", "us-west-2"], ["--env", "s", "--region", "us-west-2", "--profile", "p"], ["--env", "s", "--region", "us-west-2", "--json", "--json"], ["--env", "s", "--region", "nowhere"], ["--env", "s", "--region", "us-west-2", "--since-days", "x"]]) {
      expect(() => parseArgs(bad), bad.join(" ")).toThrow();
    }
  });

  it("refuses every command but Scan before it leaves the process", async () => {
    const { client, commands } = fakeTable([]);
    const guarded = readOnlyClient(client);
    for (const command of [new PutCommand({ TableName: "t", Item: {} }), new UpdateCommand({ TableName: "t", Key: {}, UpdateExpression: "SET a = :a" }), new DeleteCommand({ TableName: "t", Key: {} }), new BatchWriteCommand({ RequestItems: {} }), new TransactWriteCommand({ TransactItems: [] }), new GetCommand({ TableName: "t", Key: {} }), new QueryCommand({ TableName: "t" })]) {
      await expect(guarded.send(command as never)).rejects.toThrow(/read-only/);
    }
    expect(commands).toEqual([]);
  });

  it("reads every lesson head across pages, skips other items, and counts the ones that do not parse without showing them", async () => {
    const { client, commands } = fakeTable(items);
    const { rows, unreadable } = await readLessonHeads(client, "t");
    expect(rows.map((r) => r.lesson.id)).toEqual(["les_s1", "les_s2", "les_s3"]);
    expect(unreadable).toBe(1);
    expect(new Set(commands)).toEqual(new Set(["ScanCommand"]));
    expect(commands.length).toBeGreaterThan(1);
  });

  it("main prints the report as JSON with counts only, sends nothing but Scan, and needs no AWS", async () => {
    const heads = [head(lessons[0]!), head(lessons[1]!)];
    const { client, commands } = fakeTable(heads, 1);
    const out: string[] = [];
    const deps: MainDependencies = { createDocumentClient: () => client, now: () => 10_000, out: (t) => out.push(t), err: () => undefined, sleep: async () => undefined, env: {} };
    const report: RepoEligibilityReport = await main(["--env", "staging", "--region", "us-west-2", "--json", "--pause-ms", "0"], deps);
    expect(report).toMatchObject({ active: 2, eligibleForAny: 1 });
    const printed = JSON.parse(out.join("")) as Record<string, unknown>;
    expect(printed).toMatchObject({ region: "us-west-2", unreadable: 0, active: 2, eligibleForAny: 1 });
    for (const secret of ["TITLE-s1", "BODY-s2", "author-of-s1", "CHANNEL-SECRET", "run-s1"]) {
      expect(JSON.stringify(heads), `control ${secret}`).toContain(secret);
      expect(out.join(""), secret).not.toContain(secret);
    }
    expect(new Set(commands)).toEqual(new Set(["ScanCommand"]));
  });

  it("retries nothing it should not: a scan that does not advance, or throttles five times in a row, stops with a plain error", async () => {
    const stuck: ReportClient = { send: async () => ({ Items: [], LastEvaluatedKey: { at: 1 } }) };
    await expect(readLessonHeads(stuck, "t")).rejects.toThrow(/did not advance/);
    const throttled: ReportClient = { send: async () => { throw Object.assign(new Error("slow down"), { name: "ThrottlingException" }); } };
    await expect(readLessonHeads(throttled, "t", { sleep: async () => undefined })).rejects.toThrow(/throttled 5 times/);
  });
});
