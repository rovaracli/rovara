import { expect, it, vi } from "vitest";
import { chainRunViewOf } from "../support/chain-run-view.js";
import { DeveloperTaskViewSchema } from "@agentx/cloud-contracts";
import { sessionDiff, type SessionDiffDependencies } from "../../packages/broker/src/agent-sessions/diff.js";
import { ARJUN, BO, CELL, ORG_A, ORG_B, PRIYA, sessionWorld } from "../support/agent-session-world.js";
function setup() {
 const w = sessionWorld(), { sessionId, taskId } = w.seedSession();
 const taskKey = { pk: "DEVTASK#" + taskId, sk: "META" };w.db.set({ ...w.db.get(taskKey)!, startingRevision: 1 });
 w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "view");
 const files = vi.fn(async () => ({ files: [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "+ghp_" + "x".repeat(36) }], nextPage: 2 }));
 const repository = vi.fn(async (): Promise<string | undefined> => "https://github.com/acme/app");
 const deps: SessionDiffDependencies = { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL,
 taskView: async task => DeveloperTaskViewSchema.parse({ taskId: task.taskId, project: task.project, title: "Fix", status: "RUNNING", startingRevision: 1, client: "test", shared: false, createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:00:00.000Z", events: [], pullRequests: [{ repository: "app", number: 42, url: "https://github.com/acme/app/pull/42", state: "open" }] }),
 diff: { repository, files, pullRequests: async () => [{ repository: "app", number: 42, url: "https://github.com/acme/app/pull/42", state: "open" }] } };
 return { w, sessionId, taskId, deps, files, repository };
}
it("allows an explicit view share and redacts token text", async () => {
 const f = setup();expect(await sessionDiff(f.deps, f.w.caller(ARJUN), f.sessionId, { repository: "app", number: 42, page: 1 })).toMatchObject({ files: [{ patch: "+[REDACTED]" }], nextPage: 2 });
 expect(f.files).toHaveBeenCalledWith("https://github.com/acme/app", 42, { page: 1 }, { orgId: ORG_A });
});
it("omits patches over the byte limit", async () => {
 const f = setup();f.files.mockResolvedValue({ files: [{ filename: "large", status: "modified", additions: 1, deletions: 0, patch: "a".repeat(70_000) }], nextPage: 2 });
 expect(await sessionDiff(f.deps, f.w.caller(PRIYA), f.sessionId, { repository: "app", number: 42, page: 1 })).toMatchObject({ files: [{ patchOmitted: "too_large" }] });
});
it("refuses foreign orgs and PR selectors before any GitHub file read", async () => {
 for (const input of [{ who: BO, org: ORG_B, repository: "app", number: 42 }, { who: ARJUN, org: ORG_A, repository: "outside", number: 42 }, { who: ARJUN, org: ORG_A, repository: "app", number: 43 }]) {
 const f = setup();await expect(sessionDiff(f.deps, f.w.caller(input.who, input.org), f.sessionId, { repository: input.repository, number: input.number, page: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });expect(f.files).not.toHaveBeenCalled();
 }
});
it("refuses a repository absent from the pinned project before GitHub", async () => {
 const f = setup();f.repository.mockResolvedValue(undefined);
 await expect(sessionDiff(f.deps, f.w.caller(ARJUN), f.sessionId, { repository: "app", number: 42, page: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });expect(f.files).not.toHaveBeenCalled();
});

it("maps an unbound installation to the same invisible diff response", async () => {
 const f = setup();f.files.mockRejectedValue(Object.assign(new Error("not connected"), { code: "GITHUB_NOT_CONNECTED" }));
 await expect(sessionDiff(f.deps, f.w.caller(ARJUN), f.sessionId, { repository: "app", number: 42, page: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("mints exactly two read permissions only after the live org binding check", async () => {
 const { generateKeyPairSync } = await import("node:crypto");
 const { GitHubAppCredentialProvider } = await import("../../packages/broker/src/github-app.js");
 const { agentXError } = await import("@rovara-code/contracts");
 const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
 for (const bound of [true, false]) {
 const calls: string[] = [], tokenBodies: unknown[] = [];
 const provider = new GitHubAppCredentialProvider({ credentialRef: "test", appId: "123", getPrivateKey: async () => key,
 requireInstallationBound: async org => { expect(org).toBe(ORG_A);calls.push("binding");if (!bound) throw agentXError("GITHUB_NOT_CONNECTED", "not connected"); },
 fetchImplementation: async (input, init) => {
 const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
 if (url.endsWith("/installation")) return Response.json({ id: 123, account: { login: "acme" } });
 if (url.endsWith("/access_tokens")) { calls.push("mint");if (typeof init?.body !== "string") throw new Error("expected JSON body");tokenBodies.push(JSON.parse(init.body));return Response.json({ token: "fake-test-only", expires_at: "2030-01-01T00:00:00Z" }); }
 calls.push("files");expect(url).toBe("https://api.github.com/repos/acme/app/pulls/42/files?per_page=100&page=2");
 return Response.json([{ filename: "a", status: "modified", additions: 1, deletions: 0, patch: "+full", previous_filename: "b" }], { headers: { link: '<https://api.github.com/anything>; rel="next"' } });
 } });
 if (bound) {
 expect(await provider.listPullRequestFiles("https://github.com/acme/app", 42, { page: 2 }, { orgId: ORG_A })).toMatchObject({ files: [{ patch: "+full", previous_filename: "b" }], nextPage: 3 });
 expect(calls).toEqual(["binding", "mint", "files"]);expect(tokenBodies).toEqual([{ repositories: ["app"], permissions: { pull_requests: "read", contents: "read" } }]);
 } else {
 await expect(provider.listPullRequestFiles("https://github.com/acme/app", 42, { page: 2 }, { orgId: ORG_A })).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });expect(calls).toEqual(["binding"]);expect(tokenBodies).toEqual([]);
 }
 }
});

it("dispatches only the read diff route and rejects malformed selectors without GitHub", async () => {
 const { routeAgentSessionRequest } = await import("../../packages/broker/src/agent-sessions/routes.js");
 const f = setup();const path = "/v1/app/sessions/" + f.sessionId + "/diff";
 const url = new URL(path + "?repository=app&number=42&page=1", CELL);
 const request = { requestId: "diff-test", method: "GET", path: url.pathname + url.search, headers: {} };
 expect(await routeAgentSessionRequest(f.deps, f.w.caller(ARJUN), request, url)).toMatchObject({ pullRequest: { number: 42 } });
 f.files.mockClear();
 for (const suffix of ["?repository=app&number=0", "?repository=app&number=42&page=-1", "?repository=app&number=42&page=1.5"]) {
 const bad = new URL(path + suffix, CELL);await expect(routeAgentSessionRequest(f.deps, f.w.caller(ARJUN), request, bad)).rejects.toMatchObject({ code: "NOT_FOUND" });
 }
 await expect(routeAgentSessionRequest(f.deps, f.w.caller(ARJUN), { ...request, method: "POST" }, url)).rejects.toMatchObject({ code: "NOT_FOUND" });expect(f.files).not.toHaveBeenCalled();
});
it("caps output to one file page and counts UTF-8 bytes", async () => {
 const f = setup();f.files.mockResolvedValue({ files: Array.from({ length: 101 }, (_, i) => ({ filename: "file" + i, status: "modified", additions: 1, deletions: 0, patch: "é".repeat(33_000) })), nextPage: 2 });
 const diff = await sessionDiff(f.deps, f.w.caller(ARJUN), f.sessionId, { repository: "app", number: 42, page: 1 });expect(diff.files).toHaveLength(100);expect(diff.files.every(file => file.patch === undefined && file.patchOmitted === "too_large")).toBe(true);
});

it("normalizes copied, changed and unchanged GitHub files without losing the page", async () => {
 const f = setup();
 f.files.mockResolvedValue({ files: ["copied", "changed", "unchanged"].map(status => ({ filename: status + ".ts", status, previous_filename: "original.ts", additions: 1, deletions: 0, patch: "+safe" })), nextPage: 2 });
 const result = await sessionDiff(f.deps, f.w.caller(ARJUN), f.sessionId, { repository: "app", number: 42, page: 1 });
 expect(result.files.map(file => file.status)).toEqual(["added", "modified", "modified"]);
 expect(result.files[0]).toMatchObject({ path: "copied.ts", previousPath: "original.ts", patch: "+safe" });
 expect(result.nextPage).toBe(2);
});

it("reuses read-only diff tokens across pages but checks the org binding on every read", async () => {
 const { generateKeyPairSync } = await import("node:crypto");
 const { GitHubAppCredentialProvider } = await import("../../packages/broker/src/github-app.js");
 const { agentXError } = await import("@rovara-code/contracts");
 const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
 let now = Date.parse("2026-10-24T12:00:00Z"), mints = 0, bindings = 0, bound = true;
 const provider = new GitHubAppCredentialProvider({ credentialRef: "test", appId: "123", getPrivateKey: async () => key, now: () => now,
 requireInstallationBound: async () => { bindings++;if (!bound) throw agentXError("GITHUB_NOT_CONNECTED", "not connected"); },
 fetchImplementation: async (input, init) => {
 const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
 if (url.endsWith("/installation")) return Response.json({ id: 123, account: { login: "acme" } });
 if (url.endsWith("/access_tokens")) { mints++;if (typeof init?.body !== "string") throw new Error("Expected JSON body");expect(JSON.parse(init.body)).toEqual({ repositories: ["app"], permissions: { contents: "read", pull_requests: "read" } });return Response.json({ token: "fake-test-only", expires_at: "2030-01-01T00:00:00Z" }); }
 return Response.json([{ filename: "a", status: "modified", additions: 1, deletions: 0 }]);
 } });
 await Promise.all([1, 2, 3].map(page => provider.listPullRequestFiles("https://github.com/acme/app", 42, { page }, { orgId: ORG_A })));
 expect(mints).toBe(1);expect(bindings).toBe(3);
 bound = false;await expect(provider.listPullRequestFiles("https://github.com/acme/app", 42, { page: 4 }, { orgId: ORG_A })).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });expect(mints).toBe(1);
 bound = true;now += 300_001;await provider.listPullRequestFiles("https://github.com/acme/app", 42, { page: 5 }, { orgId: ORG_A });expect(mints).toBe(2);
});

it("checks view access without rebuilding decisions or the full session view for a diff", async () => {
 const f = setup(), fullView = vi.fn(f.deps.taskView.bind(f.deps));f.deps.taskView = fullView;
 await sessionDiff(f.deps, f.w.caller(ARJUN), f.sessionId, { repository: "app", number: 42, page: 1 });
 expect(fullView).not.toHaveBeenCalled();
});

function chainDiffSetup() {
 const f=setup(),chain=f.w.seedSession({kind:"chain"}),stored=f.w.db.get({pk:"DEVTASK#"+f.taskId,sk:"META"})!;
 f.w.db.set({...stored,chain:{chainRunId:chain.sessionId}});
 const runView=vi.fn(async()=>chainRunViewOf(chain.sessionId,{sections:[{seq:1,stepId:"fix",name:"Fix",kind:"agent",status:"running",attempt:1,startedAt:"2026-10-22T08:00:00.000Z",detail:{kind:"task",taskId:f.taskId,rovaraCode:true}}]}));
 const stepTask=vi.fn(async()=>f.deps.taskView(stored as unknown as Parameters<typeof f.deps.taskView>[0],{events:0,details:true,actor:"viewer"}));
 f.deps.chain={runView,stepTask};return {...f,chain,runView,stepTask};
}
it("reads only a readable chain step's own pull request and pinned repository revision",async()=>{
 const f=chainDiffSetup();
 const result=await sessionDiff(f.deps,f.w.caller(PRIYA),f.chain.sessionId,{repository:"app",number:42,page:1});
 expect(result.pullRequest.number).toBe(42);expect(f.stepTask).toHaveBeenCalledWith({kind:"session",developerId:PRIYA},f.chain.sessionId,1);
 expect(f.repository).toHaveBeenCalledWith(ORG_A,"web",1,"app");expect(f.files).toHaveBeenCalledTimes(1);
});
it("refuses chain diff reads without start permission, across organizations, or from unrelated task records",async()=>{
 for(const mode of ["viewer","foreign","unrelated","selector","revision","stored-org","stored-project"]){
 const f=chainDiffSetup();if(mode==="viewer")f.w.grant(PRIYA,"web","viewer");
 if(["revision","stored-org","stored-project"].includes(mode)){const key={pk:"DEVTASK#"+f.taskId,sk:"META"};f.w.db.set({...f.w.db.get(key)!,...(mode==="revision"?{startingRevision:2}:mode==="stored-org"?{orgId:ORG_B}:{project:"ops"})});}
 if(mode==="unrelated"){const key={pk:"DEVTASK#"+f.taskId,sk:"META"};f.w.db.set({...f.w.db.get(key)!,chain:{chainRunId:"crn_"+"z".repeat(20)}});}
 await expect(sessionDiff(f.deps,mode==="foreign"?f.w.caller(BO,ORG_B):f.w.caller(PRIYA),f.chain.sessionId,{repository:"app",number:mode==="selector"?43:42,page:1})).rejects.toMatchObject({code:"NOT_FOUND"});expect(f.files).not.toHaveBeenCalled();
 }
});
it("refuses malformed or excessive chain sections before reading step tasks",async()=>{
 for(const sections of [undefined,Array.from({length:31},(_,i)=>({seq:i+1,stepId:"fix",name:"Fix",kind:"agent",status:"running",attempt:1,startedAt:"2026-10-22T08:00:00.000Z",detail:{kind:"task",taskId:"11111111-1111-4111-8111-111111111111",rovaraCode:true}}))]){
 const f=chainDiffSetup();f.runView.mockResolvedValue({...chainRunViewOf(f.chain.sessionId),sections} as ReturnType<typeof chainRunViewOf>);
 await expect(sessionDiff(f.deps,f.w.caller(PRIYA),f.chain.sessionId,{repository:"app",number:42,page:1})).rejects.toMatchObject({code:"NOT_FOUND"});expect(f.stepTask).not.toHaveBeenCalled();expect(f.files).not.toHaveBeenCalled();
 }
});
for(const code of ["NOT_FOUND","FORBIDDEN","RUNTIME_UNAVAILABLE"] as const)it("handles an earlier chain step read refusal: "+code,async()=>{
 const f=chainDiffSetup(),run=await f.runView(),section=run.sections[0]!;
 f.runView.mockResolvedValue({...run,sections:[section,{...section,seq:2}]});
 const { agentXError } = await import("@rovara-code/contracts");f.stepTask.mockRejectedValueOnce(agentXError(code,"Step unavailable."));
 if(code==="RUNTIME_UNAVAILABLE"){await expect(sessionDiff(f.deps,f.w.caller(PRIYA),f.chain.sessionId,{repository:"app",number:42,page:1})).rejects.toMatchObject({code});expect(f.files).not.toHaveBeenCalled();}
 else{expect(await sessionDiff(f.deps,f.w.caller(PRIYA),f.chain.sessionId,{repository:"app",number:42,page:1})).toMatchObject({pullRequest:{number:42}});expect(f.stepTask).toHaveBeenLastCalledWith({kind:"session",developerId:PRIYA},f.chain.sessionId,2);}
});
