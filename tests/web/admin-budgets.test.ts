// @vitest-environment jsdom
import { it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
const orgId="org_aaaaaaaaaaaaaaaaaaaa", developerId="a".repeat(64);
const settings={orgId,checkedAt:"2026-10-27T12:00:00Z",coverage:"monthly_base_settings_only",orgMonthly:{kind:"limited",microdollars:500_000_000,source:"cloud_default"},memberDefaultMonthly:{kind:"limited",microdollars:29_000_000,source:"configured"},memberOverrideCount:2,memberOverrideCoverage:"configured_only_membership_not_checked",usage:"not_checked",topUps:"not_checked",enforcement:"not_checked"};
function mount(options:{role?:string;respond?:(r:ApiRequest)=>Promise<ApiResponse>;theme?:"light"|"dark";width?:number;prime?:boolean}={}){
 const nav=AppNavSchema.parse({me:{developerId,name:"Priya",orgRole:"owner"},org:{name:"Acme"},homeCount:0,projects:[],shared:{agents:[],sessions:[]},features:{admin:true,localAgents:false,usage:false,chains:false,describe:false,notices:false}}),me={developer:{id:developerId,name:"Priya",orgRole:options.role??"owner"},org:{orgId,name:"Acme",plan:"team"},identities:[]};
 const f=fakeHost(async r=>r.path.endsWith("/me")?{status:200,body:me}:r.path.endsWith("/nav")?{status:200,body:nav}:options.respond?.(r)??{status:200,body:settings});if(options.width!==undefined)f.host.viewport={width:()=>options.width??1280,subscribe:()=>()=>undefined};f.storage.set("rovara.theme",options.theme??"light");const query=createQueryClient();query.setQueryData(["nav"],nav);if(options.prime){query.setQueryData(["admin","identity"],me);query.setQueryData(["admin","budget-settings"],{...settings,orgId:"org_bbbbbbbbbbbbbbbbbbbb",orgMonthly:{kind:"limited",microdollars:777_000_000,source:"configured"}});}const router=createMemoryRouter(appRoutes(nav.features),{initialEntries:["/app/admin/money/budgets"]});const view=renderUi(h(AppHostProvider,{host:f.host,children:h(QueryClientProvider,{client:query,children:h(ThemeProvider,{host:f.host,children:h(RouterProvider,{router})})})}));return{...f,...view,query,router,me,close(){view.unmount();router.dispose();query.clear();}};
}
for(const role of ["owner","admin"])it(`lets ${role} read monthly base settings with explicit coverage and no money writes`,async()=>{const f=mount({role});try{await screen.findByRole("table",{name:"Monthly base budgets"});expect(screen.getByText("$500.00")).toBeTruthy();expect(screen.getByText("$29.00")).toBeTruthy();expect(screen.getByText("Existing cloud default")).toBeTruthy();expect(screen.getByText(/2 configured member overrides/)).toBeTruthy();expect(screen.getByText(/Current membership and individual limits are not checked/)).toBeTruthy();expect(screen.getByText(/Monthly base budgets are read only/)).toBeTruthy();expect(screen.getByText(/Usage, top-ups and enforcement are not checked/)).toBeTruthy();expect(screen.getByText(/does not determine whether a task can start/)).toBeTruthy();expect(screen.queryByRole("button",{name:/save|confirm/i})).toBeNull();expect(f.request.mock.calls.every(([r])=>r.method==="GET")).toBe(true);expect(screen.getByRole("link",{name:"Spending"})).toBeTruthy();}finally{f.close();}});
it("distinguishes zero from unlimited and preserves display of a single microdollar",async()=>{const f=mount({respond:async()=>({status:200,body:{...settings,orgMonthly:{kind:"limited",microdollars:0,source:"configured"},memberDefaultMonthly:{kind:"unlimited",source:"unset"}}})});try{await screen.findByText("$0.00");expect(screen.getByText("Unlimited (not configured)")).toBeTruthy();f.request.mockImplementation(async r=>r.path.endsWith("/me")?{status:200,body:f.me}:{status:200,body:{...settings,orgMonthly:{kind:"limited",microdollars:1,source:"configured"}}});fireEvent.click(screen.getByRole("button",{name:"Refresh budgets"}));await screen.findByText("$0.000001");}finally{f.close();}});
for(const status of [403,404,429,503])it(`hides cached financial amounts after ${status} without raw errors or fallback`,async()=>{const f=mount();try{await screen.findByText("$500.00");f.request.mockImplementation(async r=>r.path.endsWith("/me")?{status:200,body:f.me}:{status,body:{error:{code:"RUNTIME_UNAVAILABLE",message:"private upstream detail"}}});fireEvent.click(screen.getByRole("button",{name:"Refresh budgets"}));await waitFor(()=>expect(screen.queryByText("$500.00")).toBeNull());expect(screen.queryByRole("table")).toBeNull();expect(screen.queryByText("private upstream detail")).toBeNull();expect(screen.getByRole("alert")).toBeTruthy();expect(f.request.mock.calls.filter(([r])=>r.path.includes("budget")&&!r.path.endsWith("/budget-settings")).length).toBe(0);expect(f.request.mock.calls.filter(([r])=>r.path.endsWith("/budget-settings")).length).toBe(2);}finally{f.close();}});
for(const bad of [{...settings,orgId:"org_bbbbbbbbbbbbbbbbbbbb"},{...settings,usage:0},{...settings,orgMonthly:{kind:"limited",microdollars:-1,source:"configured"}}])it("refuses a foreign or malformed budget projection instead of showing plausible amounts",async()=>{const f=mount({respond:async()=>({status:200,body:bad})});try{await screen.findByRole("alert");expect(screen.queryByText("$500.00")).toBeNull();expect(screen.queryByRole("table")).toBeNull();}finally{f.close();}});
for(const field of ["org","person","role"] as const)for(const late of [200,401])it(`discards late ${late} budget data on a mounted ${field} change without redirecting the new scope`,async()=>{let resolve!:(value:ApiResponse)=>void;const pending=new Promise<ApiResponse>(done=>{resolve=done;});const f=mount({respond:()=>pending});try{await screen.findByRole("button",{name:"Refresh budgets"});await waitFor(()=>expect(f.request.mock.calls.some(([r])=>r.path.endsWith("/budget-settings"))).toBe(true));if(field==="org")f.me.org.orgId="org_bbbbbbbbbbbbbbbbbbbb";else if(field==="person")f.me.developer.id="c".repeat(64);else f.me.developer.orgRole="admin";f.request.mockImplementation(async r=>r.path.endsWith("/me")?{status:200,body:f.me}:{status:200,body:{...settings,orgId:f.me.org.orgId,orgMonthly:{kind:"limited",microdollars:777_000_000,source:"configured"}}});await act(async()=>{await f.query.invalidateQueries({queryKey:["admin","identity"]});});await screen.findByText("$777.00");await act(async()=>{resolve(late===200?{status:200,body:settings}:{status:401,body:{error:{code:"AUTH_REQUIRED"}}});});expect(screen.queryByText("$500.00")).toBeNull();expect(f.host.signIn).not.toHaveBeenCalled();expect(f.query.getQueriesData({queryKey:["admin","budget-settings",orgId,developerId,"owner"]})).toEqual([]);}finally{f.close();}});
it("keeps the page and focused refresh during background identity and data checks",async()=>{const f=mount();try{await screen.findByText("$500.00");const button=screen.getByRole("button",{name:"Refresh budgets"});button.focus();let resolve!:(value:ApiResponse)=>void;let pending=new Promise<ApiResponse>(done=>{resolve=done;});f.request.mockImplementation(r=>r.path.endsWith("/me")?pending:Promise.resolve({status:200,body:settings}));let recheck!:Promise<void>;await act(async()=>{recheck=f.query.invalidateQueries({queryKey:["admin","identity"]});});await waitFor(()=>expect(button.getAttribute("aria-disabled")).toBe("true"));expect(document.activeElement===button).toBe(true);expect(screen.getByRole("table")).toBeTruthy();const before=f.request.mock.calls.length;fireEvent.click(button);expect(f.request.mock.calls.length).toBe(before);await act(async()=>{resolve({status:200,body:f.me});await recheck;});pending=new Promise<ApiResponse>(done=>{resolve=done;});f.request.mockImplementation(r=>r.path.endsWith("/me")?Promise.resolve({status:200,body:f.me}):pending);fireEvent.click(button);await waitFor(()=>expect(button.getAttribute("aria-disabled")).toBe("true"));expect(document.activeElement===button).toBe(true);expect(screen.getByRole("table")).toBeTruthy();await act(async()=>{resolve({status:200,body:settings});});expect(document.activeElement===button).toBe(true);}finally{f.close();}});
it("clears money cache on role loss and does not read budgets on phones",async()=>{const f=mount();try{await screen.findByText("$500.00");f.me.developer.orgRole="member";await act(async()=>{await f.query.invalidateQueries({queryKey:["admin","identity"]});});await screen.findByRole("heading",{name:"Administration unavailable"});expect(f.query.getQueriesData({queryKey:["admin","budget-settings"]})).toEqual([]);}finally{f.close();}const phone=mount({width:390});try{await screen.findByText(/Open this on a larger screen/);expect(phone.request.mock.calls.some(([r])=>r.path.includes("budget"))).toBe(false);}finally{phone.close();}});
for(const theme of ["light","dark"] as const)it(`has accessible read-only monthly budgets in ${theme}`,async()=>{const f=mount({theme});try{await screen.findByRole("table",{name:"Monthly base budgets"});await expectNoAxeViolations(f.container);}finally{f.close();}});

it("never reuses an unscoped foreign cache and binds the query to org person and role",async()=>{const f=mount({prime:true});try{await screen.findByText("$500.00");expect(screen.queryByText("$777.00")).toBeNull();expect(f.query.getQueriesData({queryKey:["admin","budget-settings",orgId,developerId,"owner"]}).length).toBe(1);}finally{f.close();}});
for(const role of ["member","maintainer","future-role"])it(`never requests monthly budgets for initial ${role} access`,async()=>{const f=mount({role});try{await screen.findByRole("heading",{name:"Administration unavailable"});expect(f.request.mock.calls.some(([r])=>r.path.includes("budget"))).toBe(false);expect(screen.queryByRole("table")).toBeNull();}finally{f.close();}});

it("does not repeat an unsuccessful initial budget read when only identity rechecks; Refresh remains deliberate",async()=>{const fail={status:503,body:{error:{code:"RUNTIME_UNAVAILABLE"}}},f=mount({respond:async()=>fail});try{await screen.findByRole("alert");const reads=()=>f.request.mock.calls.filter(([r])=>r.path.endsWith("/budget-settings")).length;expect(reads()).toBe(1);let resolve!:(r:ApiResponse)=>void;const pending=new Promise<ApiResponse>(done=>{resolve=done;});f.request.mockImplementation(r=>r.path.endsWith("/me")?pending:Promise.resolve(fail));let checking!:Promise<void>;await act(async()=>{checking=f.query.invalidateQueries({queryKey:["admin","identity"]});});await screen.findByText("Checking company access...");await act(async()=>{resolve({status:200,body:f.me});await checking;});await waitFor(()=>expect(screen.getByRole("button",{name:"Refresh budgets"}).getAttribute("aria-disabled")).toBe("false"));expect(reads()).toBe(1);fireEvent.click(screen.getByRole("button",{name:"Refresh budgets"}));await waitFor(()=>expect(reads()).toBe(2));}finally{f.close();}});

it("edits an exact company task stop with original revision and keeps monthly settings separate", async () => {
 const context = { orgId, scopeKind: "company", revision: 3, sourceDigest: "c".repeat(64), policy: { kind: "limited", stopMicrousd: 2000000 } };
 const f = mount({ respond: async r => r.path.includes("task-stop-policy") ? { status: 200, body: r.method === "GET" ? context : { requestId: (r.body as { requestId: string }).requestId, state: "applied", revision: 4 } } : { status: 200, body: settings } });
 try {
  await screen.findByRole("table", { name: "Monthly base budgets" });
  fireEvent.click(screen.getByRole("button", { name: "Load company task stop" }));
  await screen.findByLabelText("Task stop amount (USD)");
  fireEvent.change(screen.getByLabelText("Task stop amount (USD)"), { target: { value: "1.234567" } });
  fireEvent.click(screen.getByRole("button", { name: "Review task stop change" }));
  await screen.findByText(/New task stop: \$1.234567/);
  fireEvent.click(screen.getByRole("button", { name: "Apply tightening" }));
  await screen.findByText(/Task stop change applied/);
  const writes = f.request.mock.calls.map(([r]) => r).filter(r => r.method === "PUT");expect(writes).toHaveLength(1);
  expect(writes[0]?.body).toMatchObject({ expectedRevision: 3, expectedPolicyDigest: context.sourceDigest, policy: { kind: "limited", stopMicrousd: 1234567 } });
  expect(screen.getByText("$500.00")).toBeTruthy();
 } finally { f.close(); }
});
for (const invalid of ["", "-1", "1e3", "0.0000001", "1000000.000001", "NaN"]) it(`refuses invalid exact task stop ${JSON.stringify(invalid)} without a money request`, async () => {
 const context = { orgId, scopeKind: "company", revision: 1, sourceDigest: "c".repeat(64), policy: { kind: "limited", stopMicrousd: 2_000_000 } };
 const f = mount({ respond: async r => ({ status: 200, body: r.path.includes("task-stop-policy") ? context : settings }) });
 try { await screen.findByRole("table");fireEvent.click(screen.getByRole("button", { name: "Load company task stop" }));await screen.findByLabelText("Task stop amount (USD)");fireEvent.change(screen.getByLabelText("Task stop amount (USD)"), { target: { value: invalid } });fireEvent.click(screen.getByRole("button", { name: "Review task stop change" }));await screen.findByRole("alert");expect(screen.queryByRole("button", { name: "Apply tightening" })).toBeNull();expect(f.request.mock.calls.some(([r]) => r.method !== "GET")).toBe(false); } finally { f.close(); }
});
it("discards a late unauthorized Spending response after current company access ends", async () => {
 let resolve!: (value: ApiResponse) => void;const pending = new Promise<ApiResponse>(done => { resolve = done; });
 const f = mount({ respond: async r => r.path.includes("task-stop-policy") ? pending : { status: 200, body: settings } });
 try { await screen.findByRole("table");fireEvent.click(screen.getByRole("button", { name: "Load company task stop" }));await screen.findByText("Checking task stop...");f.me.developer.orgRole = "member";await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "identity"] }); });await screen.findByRole("heading", { name: "Administration unavailable" });await act(async () => { resolve({ status: 401, body: {} }); });expect(f.host.signIn).not.toHaveBeenCalled();expect(screen.queryByText(/Current task stop/)).toBeNull(); } finally { f.close(); }
});
it("reviews a project inheritance loosening without applying it or inventing an amount", async () => {
 const context = { orgId, scopeKind: "project", project: "web", revision: 2, sourceDigest: "c".repeat(64), policy: { kind: "limited", stopMicrousd: 1234567 } };
 const f = mount({ respond: async r => ({ status: 200, body: r.path.includes("task-stop-policy") ? r.method === "GET" ? context : { requestId: (r.body as { requestId: string }).requestId, state: "pending", revision: 2, proposalId: (r.body as { requestId: string }).requestId } : settings }) });
 try { await screen.findByRole("table");fireEvent.change(screen.getByLabelText("Project name for task stop"), { target: { value: "web" } });fireEvent.click(screen.getByRole("button", { name: "Load project task stop" }));await screen.findByLabelText("Task stop policy");fireEvent.change(screen.getByLabelText("Task stop policy"), { target: { value: "inherit" } });fireEvent.click(screen.getByRole("button", { name: "Review task stop change" }));await screen.findByText(/New task stop: Inherit the company task stop/);fireEvent.click(screen.getByRole("button", { name: "Request loosening" }));await screen.findByText(/Task stop change requested/);expect(f.request.mock.calls.map(([r]) => r).find(r => r.method === "PUT")).toMatchObject({ path: "/v1/app/org/task-stop-policy/projects/web", body: { policy: { kind: "inherit" }, expectedRevision: 2 } }); } finally { f.close(); }
});
it("shows original proposed terms and binds a distinct-person decision to the displayed digest", async () => {
 const proposalId = "11111111-1111-4111-8111-111111111111", proposalDigest = "d".repeat(64);
 const context = { orgId, scopeKind: "company", revision: 2, sourceDigest: "c".repeat(64), policy: { kind: "limited", stopMicrousd: 1 }, pending: { version: 1, proposalId, requestedBy: "b".repeat(64), createdAt: "2026-10-30T23:00:00.000Z", baseRevision: 2, beforePolicy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 1 } }, proposedPolicy: { kind: "rovara_estimate" }, proposalDigest, sourceDigest: "c".repeat(64), scopeKind: "company" } };
 const f = mount({ respond: async r => ({ status: 200, body: r.path.includes("task-stop-policy") ? r.method === "GET" ? context : { requestId: (r.body as { requestId: string }).requestId, state: "applied", revision: 3, proposalId } : settings }) });
 try { await screen.findByRole("table");fireEvent.click(screen.getByRole("button", { name: "Load company task stop" }));await screen.findByText(/Original task stop: \$0.000001/);await screen.findByText(/Proposed task stop: Use Rovara's estimate/);fireEvent.click(screen.getByRole("button", { name: "Approve original task stop change" }));await screen.findByText(/Task stop change applied/);expect(f.request.mock.calls.map(([r]) => r).find(r => r.method === "POST")?.body).toMatchObject({ proposalId, expectedProposalDigest: proposalDigest, decision: "approve" }); } finally { f.close(); }
});
it("labels a seeded estimate for company review without making up a task-stop amount", async () => {
 const context = { orgId, scopeKind: "company", revision: 1, sourceDigest: "c".repeat(64), policy: { kind: "rovara_estimate" }, seedReview: { source: "bootstrap", reviewRequired: true, seededAt: "2026-10-01T00:00:00.000Z" } };
 const f = mount({ respond: async r => ({ status: 200, body: r.path.includes("task-stop-policy") ? context : settings }) });
 try { await screen.findByRole("table");fireEvent.click(screen.getByRole("button", { name: "Load company task stop" }));await screen.findByText(/This company policy was seeded during bootstrap/);expect(screen.getByText("Current task stop: Use Rovara's estimate for each task. Revision 1.")).toBeTruthy();expect(screen.queryByLabelText("Task stop amount (USD)")).toBeNull();expect(screen.queryByText("$10.00")).toBeNull(); } finally { f.close(); }
});

it("reloads a failed task stop deliberately even within the same clock tick", async () => {
 const context = { orgId, scopeKind: "company", revision: 1, sourceDigest: "c".repeat(64), policy: { kind: "limited", stopMicrousd: 1 } };let reads = 0;
 const clock = vi.spyOn(Date, "now").mockReturnValue(1), f = mount({ respond: async r => r.path.includes("task-stop-policy") ? ++reads === 1 ? { status: 503, body: {} } : { status: 200, body: context } : { status: 200, body: settings } });
 try { await screen.findByRole("table");fireEvent.click(screen.getByRole("button", { name: "Load company task stop" }));await screen.findByRole("alert");fireEvent.click(screen.getByRole("button", { name: "Load company task stop" }));await screen.findByText("Current task stop: $0.000001. Revision 1.");expect(reads).toBe(2); } finally { f.close();clock.mockRestore(); }
});

it("owner reviews impacts before two explicit enforcement confirmations, after freshness preflight", async () => {
 let state = "disabled", revision = 1;
 const reviewId = "11111111-1111-4111-8111-111111111111", digest = "d".repeat(64);
 const f = mount({ respond: async r => {
  if (r.path.includes("/enrollment")) {
   if (r.method === "PUT") { state = (r.body as { state: string }).state;revision += 1;return { status: 200, body: { orgId, requestId: (r.body as { requestId: string }).requestId, state, revision, tasksReviewed: 0, tasksAtEnable: 0, newImpacts: 0 } }; }
   return { status: 200, body: { orgId, state, revision } };
  }
  if (r.path.endsWith("/cutover-review")) return { status: 200, body: { orgId, reviewId, digest, revision, complete: true, capturedAt: "2026-11-04T15:00:00.000Z", expiresAt: "2026-11-04T15:05:00.000Z", tasks: [] } };
  return { status: 200, body: settings };
 } });
 try {
  await screen.findByRole("table");expect(f.request.mock.calls.some(([r]) => r.path.includes("enrollment"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Turn on enforcement" }));
  await screen.findByRole("heading", { name: "Review enforcement impacts" });
  const calls = f.request.mock.calls.map(([r]) => r).filter(r => /enrollment|cutover-review/.test(r.path));
  expect(calls[0]).toMatchObject({ method: "GET", path: "/v1/app/org/task-stop-policy/enrollment?fresh=1" });
  expect(calls[1]).toMatchObject({ method: "POST", path: "/v1/app/org/task-stop-policy/cutover-review" });
  expect(f.request.mock.calls.some(([r]) => r.method === "PUT")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Confirm review and mark ready" }));
  await screen.findByRole("button", { name: "Enable enforcement" });
  expect(state).toBe("ready");fireEvent.click(screen.getByRole("button", { name: "Enable enforcement" }));
  await screen.findByText("Enforcement is enabled.");expect(state).toBe("enabled");
  expect(f.request.mock.calls.filter(([r]) => r.method === "PUT").map(([r]) => r.body)).toEqual([
   expect.objectContaining({ state: "ready", expectedRevision: 1, reviewId, expectedReviewDigest: digest }),
   expect.objectContaining({ state: "enabled", expectedRevision: 2, reviewId, expectedReviewDigest: digest }),
  ]);
 } finally { f.close(); }
});
it("admin cannot load or change company enforcement", async () => {
 const f = mount({ role: "admin" });try { await screen.findByRole("table");expect(screen.queryByRole("button", { name: "Turn on enforcement" })).toBeNull();expect(f.request.mock.calls.some(([r]) => /enrollment|cutover-review/.test(r.path))).toBe(false); } finally { f.close(); }
});
it("stale sign-in stops before review and offers the existing sign-in flow", async () => {
 const f = mount({ respond: async r => r.path.includes("/enrollment") ? { status: 403, body: { error: { code: "REAUTH_REQUIRED" } } } : { status: 200, body: settings } });
 try {
  await screen.findByRole("table");fireEvent.click(screen.getByRole("button", { name: "Turn on enforcement" }));
  fireEvent.click(await screen.findByRole("button", { name: "Sign in again" }));expect(f.host.signIn).toHaveBeenCalled();
  expect(f.request.mock.calls.some(([r]) => r.method !== "GET")).toBe(false);
 } finally { f.close(); }
});
it("turning off enabled enforcement also handles REAUTH without a second-owner flow", async () => {
 const f = mount({ respond: async r => r.path.includes("/enrollment") ? r.method === "GET" ? { status: 200, body: { orgId, state: "enabled", revision: 3 } } : { status: 403, body: { error: { code: "REAUTH_REQUIRED" } } } : { status: 200, body: settings } });
 try { await screen.findByRole("table");fireEvent.click(screen.getByRole("button", { name: "Turn on enforcement" }));fireEvent.click(await screen.findByRole("button", { name: "Turn off enforcement" }));await screen.findByRole("button", { name: "Sign in again" });expect(screen.queryByText(/second owner/i)).toBeNull(); } finally { f.close(); }
});
