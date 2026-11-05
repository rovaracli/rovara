import { describe, expect, it, vi } from "vitest";
import { AppNavSchema, AppNavReaderSchema } from "../../packages/contracts/src/app-nav.js";
import { appNav, type AppNavDependencies, type NavCaller } from "../../packages/broker/src/app-nav/nav.js";
const A = "agt_aaaaaaaaaaaaaaaaaaaa", S = "ses_aaaaaaaaaaaaaaaaaaaa";
const priya: NavCaller = { orgId: "org_aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64), name: "Priya", orgRole: "member" };
function fixture() {
 let now = 1000;
 const sources = {
 projects: vi.fn(async () => [{ name: "payments" }]),
 rosters: vi.fn(async () => [{ project: "payments", agentId: A, name: "Payments expert" }]),
 live: vi.fn(async () => [{ sessionId: S, project: "payments", agentId: A, running: true, needsYou: true }]),
 home: vi.fn(async () => ({ total: 3 })),
 sharedAgents: vi.fn(async () => [{ agentId: A, name: "Payments expert" }]),
 sharedSessions: vi.fn(async () => [{ sessionId: S, title: "Investigate payment timeout" }, { sessionId: "ses_bbbbbbbbbbbbbbbbbbbb", title: "Closed task", endedAt: "2026-10-24T12:00:00Z" }]),
 org: vi.fn(async () => ({ name: "Acme", plan: "trial" as const })),
 };
 const deps: AppNavDependencies = { sources, now: () => now, webFeatures: "usage,admin,chains,notices,describe", localAgents: true };
 return { sources, deps, advance: (ms: number) => { now += ms; } };
}
describe("navigation contract and aggregation", () => {
 it("counts only caller-visible live rows, uses Home total, and omits ended shared sessions", async () => {
 const f = fixture();const value = await appNav(f.deps, priya);
 expect(value.homeCount).toBe(3);expect(value.projects).toEqual([{ name: "payments", agents: [{ agentId: A, name: "Payments expert", running: 1, needsYou: 1 }] }]);
 expect(value.shared.sessions).toEqual([{ sessionId: S, title: "Investigate payment timeout" }]);expect(value.org.trial?.state).toBe("locked");expect(value.features.admin).toBe(false);expect(value.features.usage).toBe(true);
 expect(AppNavSchema.parse(value)).toEqual(value);
 });
 it("coalesces concurrent reads, caches for five seconds, and never shares a cache between people or orgs", async () => {
 const f = fixture();await Promise.all([appNav(f.deps, priya), appNav(f.deps, priya)]);
 for (const source of Object.values(f.sources)) expect(source).toHaveBeenCalledTimes(1);
 await appNav(f.deps, { ...priya, developerId: "b".repeat(64) });for (const source of Object.values(f.sources)) expect(source).toHaveBeenCalledTimes(2);
 await appNav(f.deps, { ...priya, orgId: "org_bbbbbbbbbbbbbbbbbbbb" });for (const source of Object.values(f.sources)) expect(source).toHaveBeenCalledTimes(3);
 f.advance(5000);await appNav(f.deps, priya);for (const source of Object.values(f.sources)) expect(source).toHaveBeenCalledTimes(4);
 });
 it("limits projects and shared entries without multiplying source reads", async () => {
 const f = fixture();f.sources.projects.mockResolvedValue(Array.from({ length: 60 }, (_, i) => ({ name: "project-" + String(i).padStart(2, "0") })));
 const value = await appNav(f.deps, priya);expect(value.projects).toHaveLength(50);expect(f.sources.rosters).toHaveBeenCalledTimes(1);expect(value.projects[0]?.name).toBe("project-00");
 });
 it("gates feature switches and rechecks a changed org role before reusing a cached projection", async () => {
 const f = fixture();expect((await appNav(f.deps, { ...priya, orgRole: "admin" })).features.admin).toBe(true);
 expect((await appNav(f.deps, priya)).features.admin).toBe(false);expect(f.sources.projects).toHaveBeenCalledTimes(2);
 expect((await appNav({ ...f.deps, webFeatures: "" }, priya)).features).toEqual({ localAgents: true, usage: false, admin: false, chains: false, notices: false, describe: false });
 });
 it("fails closed when production sources are missing and does not cache a failed source read", async () => {
 await expect(appNav({ now: Date.now, webFeatures: "", localAgents: false }, priya)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
 const f = fixture();f.sources.home.mockRejectedValueOnce(new Error("unavailable"));await expect(appNav(f.deps, priya)).rejects.toThrow();expect((await appNav(f.deps, priya)).homeCount).toBe(3);
 });
 it("QA6-10: carries the release the deploy says, only as a plain release number, and nothing when there is none or it is not one", async () => {
 const f = fixture();
 expect((await appNav({ ...f.deps, release: "0.5.8" }, priya)).release).toBe("0.5.8");
 for (const bad of [undefined, "", "0.5", "v0.5.8", "0.5.8-rc1", "0.5.8 <b>x</b>", "1".repeat(40)]) {
  const value = await appNav({ ...fixture().deps, ...(bad === undefined ? {} : { release: bad }) }, priya);
  expect(value, String(bad)).not.toHaveProperty("release");
 }
 });
 it("keeps unknown enum values and extra fields in the client reader, but strict server shapes reject extras", async () => {
 const value = await appNav(fixture().deps, priya);expect(AppNavSchema.safeParse({ ...value, extra: true }).success).toBe(false);
 expect(AppNavReaderSchema.parse({ ...value, me: { ...value.me, orgRole: "future" }, extra: true })).toMatchObject({ me: { orgRole: "unknown" }, extra: true });
 });
});

it("keeps private-install and paid organizations out of trial prompts", async () => {
 const { orgTrial } = await import("../../packages/broker/src/app-nav/nav.js");expect(orgTrial({ plan: "trial", createdBy: "system" })).toBeUndefined();expect(orgTrial({ plan: "team", createdBy: "member" })).toBeUndefined();
});
it("bounds retained navigation projections", async () => {
 const f = fixture();for (let i = 0; i < 257; i++) await appNav(f.deps, { ...priya, developerId: i.toString(16).padStart(64, "0") });await appNav(f.deps, { ...priya, developerId: "0".repeat(64) });expect(f.sources.projects).toHaveBeenCalledTimes(258);
});
it("caps shared agents and open shared sessions independently", async () => {
 const f = fixture();f.sources.sharedAgents.mockResolvedValue(Array.from({ length: 30 }, () => ({ agentId: A, name: "Shared agent" })));f.sources.sharedSessions.mockResolvedValue(Array.from({ length: 15 }, () => ({ sessionId: S, title: "Shared session" })));const nav = await appNav(f.deps, priya);expect(nav.shared.agents).toHaveLength(20);expect(nav.shared.sessions).toHaveLength(10);
});
