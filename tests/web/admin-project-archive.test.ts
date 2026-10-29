// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { navFixture, meFixture } from "./support/fixtures.js";
import { expectNoAxeViolations } from "./support/axe.js";
const project = { name: "payments", description: "Payment service", status: "active", latestRevision: 3, repositories: [{ fullName: "Acme/payments", defaultBranch: "main" }], myRole: "maintainer", setup: { status: "ready" }, settings: { setupCommands: ["sensitive command"], testCommands: ["sensitive test"], devcontainer: null, allowedDomains: [{ domain: "docs.example.com", status: "pending" }] }, createdAt: "2026-10-01T00:00:00Z", createdBy: { developerId: "a".repeat(64), name: "Priya" } };

function mount(options: {post?: (r:ApiRequest)=>Promise<ApiResponse>; preview?:()=>ApiResponse; theme?:string}={}) {
 const me=meFixture();me.developer.orgRole="owner";const nav=navFixture({features:{admin:true,localAgents:false,usage:false,chains:false,describe:false,notices:false}});
 let status="active",revision=0;const preview=()=>({orgId:me.org.orgId,project:"payments",status,expectedRevision:revision,expectedProjectRevision:3,checkedAt:"2026-10-27T15:00:00.000Z",access:{actions:status==="active"?["archive"]:[]}});
 const f=fakeHost(async r=>{
  if(r.path.endsWith("/me"))return {status:200,body:structuredClone(me)};
  if(r.path.endsWith("/nav"))return {status:200,body:nav};
  if(r.path.endsWith("/archive-preview"))return options.preview?.()??{status:200,body:preview()};
  if(r.method==="POST"){if(options.post)return options.post(r);status="archived";revision++;return {status:200,body:{replayed:false,receipt:{project:"payments",status:"archived",revision,projectRevision:3,archivedAt:"2026-10-27T15:01:00.000Z",egressReconciliation:"pending"},current:preview(),effects:{egress:"synchronized",archiveHook:"not_configured"}}};}
  return {status:200,body:r.path.endsWith("/members")?{members:[]}: {...project,status}};
 });
 const query=createQueryClient();query.setQueryData(["nav"],nav);f.storage.set("rovara.theme",options.theme??"light");const router=createMemoryRouter(appRoutes(nav.features),{initialEntries:["/app/admin/projects/payments"]});const view=renderUi(h(AppHostProvider,{host:f.host,children:h(QueryClientProvider,{client:query,children:h(ThemeProvider,{host:f.host,children:h(RouterProvider,{router})})})}));
 return {...f,...view,me,query,router,posts:()=>f.request.mock.calls.map(([r])=>r).filter(r=>r.method==="POST"),close(){view.unmount();router.dispose();query.clear();}};
}
async function review(){fireEvent.click(await screen.findByRole("button",{name:"Review archive"}));await screen.findByRole("checkbox");}
function acknowledge(){fireEvent.click(screen.getByRole("checkbox"));}
it("requires a named fresh review and unchecked acknowledgment; cancel writes nothing",async()=>{const f=mount();await screen.findByRole("button",{name:"Review archive"});expect(f.request.mock.calls.some(([r])=>r.path.endsWith("archive-preview"))).toBe(false);await review();expect(screen.getByRole("dialog").textContent).toContain("Acme");expect(screen.getByRole("dialog").textContent).toContain("payments");expect(screen.getByRole("dialog").textContent).toContain("Existing work continues");expect(screen.getByRole("button",{name:"Archive project"})).toHaveProperty("disabled",true);fireEvent.click(screen.getByRole("button",{name:"Cancel"}));expect(f.posts()).toEqual([]);f.close();});
it("sends one scoped acknowledged write and verifies current state before showing it",async()=>{const f=mount();await review();acknowledge();fireEvent.click(screen.getByRole("button",{name:"Archive project"}));await screen.findByText("Current project status: Archived.");expect(f.posts()).toHaveLength(1);expect(f.posts()[0]?.body).toMatchObject({expectedOrgId:f.me.org.orgId,expectedRevision:0,expectedProjectRevision:3,acknowledgeNewWorkStops:true});expect((f.posts()[0]?.body as Record<string,unknown>).requestId).toMatch(/^[0-9a-f-]{36}$/);expect(f.posts()[0]?.retry).toBe("never");fireEvent.click(screen.getByRole("button",{name:"Close dialog"}));await waitFor(()=>expect(document.activeElement?.textContent).toContain("Current project status: Archived."));f.close();});
it("retains the request UUID after ambiguity and makes checking a read-only action",async()=>{const f=mount({post:async()=>{throw new Error("private transport detail");}});await review();acknowledge();fireEvent.click(screen.getByRole("button",{name:"Archive project"}));await screen.findByText(/outcome is unconfirmed/);expect(f.posts()).toHaveLength(1);const first=f.posts()[0]?.body;fireEvent.click(screen.getByRole("button",{name:"Close"}));await screen.findByText("Archive request outcome is unconfirmed. Reopen the review to check current state.");fireEvent.click(screen.getByRole("button",{name:"Review archive"}));await screen.findByRole("button",{name:"Check current state"});fireEvent.click(screen.getByRole("button",{name:"Check current state"}));await screen.findByText("Current project status: Active.");expect(f.posts()).toHaveLength(1);expect(screen.getByRole("button",{name:"Retry same archive request"})).toHaveProperty("disabled",true);acknowledge();fireEvent.click(screen.getByRole("button",{name:"Retry same archive request"}));await waitFor(()=>expect(f.posts()).toHaveLength(2));expect(f.posts()[1]?.body).toEqual(first);expect(document.body.textContent).not.toContain("private transport detail");f.close();});
it("does not confuse an original receipt with current state after a later restore",async()=>{let posted=false;const f=mount({post:async()=>{posted=true;return {status:200,body:{replayed:true,receipt:{project:"payments",status:"archived",revision:1,projectRevision:3,archivedAt:"2026-10-27T15:01:00.000Z",egressReconciliation:"pending"},current:{orgId:"org_aaaaaaaaaaaaaaaaaaaa",project:"payments",status:"active",expectedRevision:2,expectedProjectRevision:3,checkedAt:"2026-10-27T15:02:00.000Z",access:{actions:["archive"]}},effects:{egress:"not_attempted",archiveHook:"not_attempted"}}};},preview:()=>({status:200,body:{orgId:"org_aaaaaaaaaaaaaaaaaaaa",project:"payments",status:"active",expectedRevision:posted?2:0,expectedProjectRevision:3,checkedAt:"2026-10-27T15:02:00.000Z",access:{actions:["archive"]}}})});await review();acknowledge();fireEvent.click(screen.getByRole("button",{name:"Archive project"}));await screen.findByText("Current project status: Active.");expect(screen.queryByText("Current project status: Archived.")).toBeNull();expect(screen.getByText(/Original archive recorded/)).toBeTruthy();f.close();});
for(const field of ["org","person"])it(`discards a pending archive result after ${field} changes`,async()=>{let resolve!:(r:ApiResponse)=>void;const pending=new Promise<ApiResponse>(r=>{resolve=r;});const f=mount({post:()=>pending});await review();acknowledge();fireEvent.click(screen.getByRole("button",{name:"Archive project"}));if(field==="org")f.me.org.orgId="org_bbbbbbbbbbbbbbbbbbbb";else f.me.developer.id="c".repeat(64);await act(async()=>{await f.query.invalidateQueries({queryKey:["admin","identity"]});});await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());await act(async()=>resolve({status:503,body:{}}));expect(screen.queryByText(/outcome is unconfirmed/)).toBeNull();f.close();});
for(const theme of ["light","dark"])it(`has an accessible archive review in ${theme}`,async()=>{const f=mount({theme});await review();await expectNoAxeViolations(document.body);f.close();});

it("guards two synchronous clicks while the one archive write is pending",async()=>{let resolve!:(r:ApiResponse)=>void;const f=mount({post:()=>new Promise<ApiResponse>(r=>{resolve=r;})});await review();acknowledge();const button=screen.getByRole("button",{name:"Archive project"});act(()=>{fireEvent.click(button);fireEvent.click(button);});expect(f.posts()).toHaveLength(1);await act(async()=>resolve({status:503,body:{}}));await screen.findByText(/outcome is unconfirmed/);f.close();});
it("requires a new explicit review after a stale preview and never automatically posts it",async()=>{const f=mount({post:async()=>({status:409,body:{error:{code:"CHANGE_STALE",message:"sensitive stale detail"}}})});await review();acknowledge();fireEvent.click(screen.getByRole("button",{name:"Archive project"}));await screen.findByText(/The project changed/);expect(f.posts()).toHaveLength(1);fireEvent.click(screen.getByRole("button",{name:"Review latest state"}));await screen.findByRole("checkbox");expect(f.posts()).toHaveLength(1);expect(screen.getByRole("checkbox")).toHaveProperty("checked",false);expect(document.body.textContent).not.toContain("sensitive stale detail");f.close();});
for(const [canonicalStatus,canonicalCode] of [[403,"FORBIDDEN"],[409,"CHANGE_STALE"]] as const) it(`keeps a confirmed receipt when the independent read returns ${canonicalStatus}, then checks without another write`,async()=>{let posted=false,readsFail=true;const f=mount({post:async()=>{posted=true;return {status:200,body:{replayed:false,receipt:{project:"payments",status:"archived",revision:1,projectRevision:3,archivedAt:"2026-10-27T15:01:00.000Z",egressReconciliation:"pending"},current:{orgId:"org_aaaaaaaaaaaaaaaaaaaa",project:"payments",status:"archived",expectedRevision:1,expectedProjectRevision:3,checkedAt:"2026-10-27T15:02:00.000Z",access:{actions:[]}},effects:{egress:"pending",archiveHook:"pending"}}};},preview:()=>posted&&readsFail?{status:canonicalStatus,body:{error:{code:canonicalCode,message:"Synthetic canonical read refusal"}}}:{status:200,body:{orgId:"org_aaaaaaaaaaaaaaaaaaaa",project:"payments",status:posted?"archived":"active",expectedRevision:posted?1:0,expectedProjectRevision:3,checkedAt:"2026-10-27T15:02:00.000Z",access:{actions:posted?[]:["archive"]}}}});await review();acknowledge();fireEvent.click(screen.getByRole("button",{name:"Archive project"}));await screen.findByText(/Current project state is unconfirmed/);expect(screen.getByText(/Original archive recorded/)).toBeTruthy();expect(screen.queryByText("Current project status: Archived.")).toBeNull();readsFail=false;fireEvent.click(screen.getByRole("button",{name:"Check current state"}));await screen.findByText("Current project status: Archived.");expect(f.posts()).toHaveLength(1);f.close();});
for(const foreign of ["org","project"])it(`refuses a preview with a mismatched ${foreign}`,async()=>{const f=mount({preview:()=>({status:200,body:{orgId:foreign==="org"?"org_bbbbbbbbbbbbbbbbbbbb":"org_aaaaaaaaaaaaaaaaaaaa",project:foreign==="project"?"other":"payments",status:"active",expectedRevision:0,expectedProjectRevision:3,checkedAt:"2026-10-27T15:00:00.000Z",access:{actions:["archive"]}}})});fireEvent.click(await screen.findByRole("button",{name:"Review archive"}));await screen.findByText(/Couldn't check this project/);expect(screen.queryByRole("checkbox")).toBeNull();expect(f.posts()).toHaveLength(0);f.close();});

it("cancels a pending preview and ignores its late result without writing",async()=>{let resolve!:(r:ApiResponse)=>void;const pending=new Promise<ApiResponse>(r=>{resolve=r;});const f=mount();const original=f.request.getMockImplementation()!;f.request.mockImplementation(r=>r.path.endsWith("/archive-preview")?pending:original(r));fireEvent.click(await screen.findByRole("button",{name:"Review archive"}));fireEvent.click(screen.getByRole("button",{name:"Cancel"}));await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());await act(async()=>resolve({status:200,body:{orgId:f.me.org.orgId,project:"payments",status:"active",expectedRevision:0,expectedProjectRevision:3,checkedAt:"2026-10-27T15:00:00.000Z",access:{actions:["archive"]}}}));expect(screen.queryByRole("checkbox")).toBeNull();expect(f.posts()).toEqual([]);f.close();});

it("tears down a pending archive when navigating to another cached project",async()=>{let resolve!:(r:ApiResponse)=>void;const f=mount({post:()=>new Promise<ApiResponse>(r=>{resolve=r;})});await review();acknowledge();fireEvent.click(screen.getByRole("button",{name:"Archive project"}));const other={...project,name:"other",settings:{setupCommandCount:0,testCommandCount:0,devcontainer:null,allowedDomains:[]}};f.query.setQueryData(["admin","project-detail",f.me.org.orgId,f.me.developer.id,"other"],other);await act(async()=>{await f.router.navigate("/app/admin/projects/other");});await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());await act(async()=>resolve({status:200,body:{replayed:false,receipt:{project:"payments",status:"archived",revision:1,projectRevision:3,archivedAt:"2026-10-27T15:01:00.000Z",egressReconciliation:"pending"},current:{orgId:f.me.org.orgId,project:"payments",status:"archived",expectedRevision:1,expectedProjectRevision:3,checkedAt:"2026-10-27T15:02:00.000Z",access:{actions:[]}},effects:{egress:"synchronized",archiveHook:"not_configured"}}}));expect(screen.queryByText(/Original archive recorded/)).toBeNull();f.close();});

it("disables archive during a background company authority check",async()=>{const f=mount();await review();acknowledge();const original=f.request.getMockImplementation()!;let resolve!:(r:ApiResponse)=>void;const pending=new Promise<ApiResponse>(r=>{resolve=r;});f.request.mockImplementation(r=>r.path.endsWith("/me")?pending:original(r));let refresh!:Promise<unknown>;await act(async()=>{refresh=f.query.invalidateQueries({queryKey:["admin","identity"]});});await waitFor(()=>expect(screen.getByRole("button",{name:"Archive project"})).toHaveProperty("disabled",true));expect(f.posts()).toEqual([]);await act(async()=>{resolve({status:200,body:structuredClone(f.me)});await refresh;});await waitFor(()=>expect(screen.getByRole("button",{name:"Archive project"})).toHaveProperty("disabled",false));f.close();});
it("disables an open archive review when project details become stale",async()=>{const f=mount();await review();acknowledge();const original=f.request.getMockImplementation()!;f.request.mockImplementation(r=>r.path==="/v1/app/projects/payments"?Promise.resolve({status:400,body:{}}):original(r));await act(async()=>{await f.query.invalidateQueries({queryKey:["admin","project-detail"]});});await waitFor(()=>expect(screen.getByRole("button",{name:"Archive project"})).toHaveProperty("disabled",true));expect(f.posts()).toEqual([]);f.close();});

it("never relabels old repository/settings data as a newer project revision",async()=>{const f=mount({preview:()=>({status:200,body:{orgId:"org_aaaaaaaaaaaaaaaaaaaa",project:"payments",status:"active",expectedRevision:0,expectedProjectRevision:4,checkedAt:"2026-10-27T15:00:00.000Z",access:{actions:["archive"]}}})});await review();expect(f.query.getQueryData(["admin","project-detail",f.me.org.orgId,f.me.developer.id,"payments"])).toMatchObject({latestRevision:3});f.close();});

// B8: a read after an ambiguous write cannot silently replace the retained attempt's pins.
for (const changed of ["lifecycle", "configuration"] as const) it(`requires a fresh explicit archive review when ${changed} pins change after ambiguity`, async () => {
 let lifecycle = 0, configuration = 3;
 const f = mount({ post: async () => { throw new Error("Synthetic ambiguous transport failure"); }, preview: () => ({ status: 200, body: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", status: "active", expectedRevision: lifecycle, expectedProjectRevision: configuration, checkedAt: "2026-10-27T16:40:00.000Z", access: { actions: ["archive"] } } }) });
 try {
  await review();acknowledge();fireEvent.click(screen.getByRole("button", { name: "Archive project" }));
  await screen.findByText(/outcome is unconfirmed/);expect(f.posts()).toHaveLength(1);
  const original = f.posts()[0]!.body as Record<string, unknown>;
  if (changed === "lifecycle") lifecycle++;else configuration++;
  fireEvent.click(screen.getByRole("button", { name: "Check current state" }));
  await screen.findByText("Current project status: Active.");
  expect(f.posts()).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Retry same archive request" })).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Review latest state" }));
  const checkbox = await screen.findByRole("checkbox");expect(checkbox).toHaveProperty("checked", false);
  expect(f.posts()).toHaveLength(1);expect(screen.getByRole("button", { name: "Archive project" })).toHaveProperty("disabled", true);
  acknowledge();await waitFor(() => expect(screen.getByRole("button", { name: "Archive project" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Archive project" }));
  await screen.findByText(/outcome is unconfirmed/);expect(f.posts()).toHaveLength(2);
  const next = f.posts()[1]!.body as Record<string, unknown>;
  expect(next.requestId).not.toBe(original.requestId);
  expect(next).toMatchObject({ expectedOrgId: f.me.org.orgId, expectedRevision: lifecycle, expectedProjectRevision: configuration, acknowledgeNewWorkStops: true });
 } finally { f.close(); }
});

// B9: recovery distinguishes old uncertainty, a refused submission and a confirmed receipt.
it("keeps an earlier unconfirmed archive visible after fresh review and reopening", async () => {
 let posted = false;
 const f = mount({ post: async () => { posted = true;throw new Error("Synthetic lost response"); }, preview: () => ({ status: 200, body: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", status: posted ? "archived" : "active", expectedRevision: posted ? 1 : 0, expectedProjectRevision: 3, checkedAt: "2026-10-27T17:22:00.000Z", access: { actions: posted ? [] : ["archive"] } } }) });
 try {
  await review();acknowledge();fireEvent.click(screen.getByRole("button", { name: "Archive project" }));await screen.findByText(/outcome is unconfirmed/);
  fireEvent.click(screen.getByRole("button", { name: "Check current state" }));await screen.findByText("Current project status: Archived.");
  fireEvent.click(screen.getByRole("button", { name: "Review latest state" }));await screen.findByText("An earlier archive request remains unconfirmed. Reviewing new state does not confirm its outcome.");
  expect(f.posts()).toHaveLength(1);expect(screen.queryByText(/Original archive recorded/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));await screen.findByText(/An earlier archive request remains unconfirmed/);
  fireEvent.click(screen.getByRole("button", { name: "Review archive" }));await screen.findByText("An earlier archive request remains unconfirmed. Reviewing new state does not confirm its outcome.");expect(f.posts()).toHaveLength(1);
 } finally { f.close(); }
});
for (const [status, code] of [[400, "CONFIG_INVALID"], [403, "FORBIDDEN"], [404, "NOT_FOUND"], [429, "TOO_MANY_REQUESTS"]] as const) it(`distinguishes a definite ${status} archive refusal from an unknown outcome`, async () => {
 const f = mount({ post: async () => ({ status, body: { error: { code, message: "private synthetic refusal detail" } } }) });
 try { await review();acknowledge();fireEvent.click(screen.getByRole("button", { name: "Archive project" }));await screen.findByText("This submission was refused. No new archive was recorded by this submission.");expect(screen.queryByText(/outcome is unconfirmed/)).toBeNull();expect(screen.queryByRole("button", { name: "Retry same archive request" })).toBeNull();expect(f.posts()).toHaveLength(1);expect(document.body.textContent).not.toContain("private synthetic refusal detail"); } finally { f.close(); }
});
it("keeps the earlier outcome unknown if a retry of its UUID is definitively refused", async () => {
 let calls = 0;const f = mount({ post: async () => { if (++calls === 1) throw new Error("Synthetic lost response");return { status: 403, body: { error: { code: "FORBIDDEN", message: "Synthetic refusal" } } }; } });
 try { await review();acknowledge();fireEvent.click(screen.getByRole("button", { name: "Archive project" }));await screen.findByText(/outcome is unconfirmed/);const original = f.posts()[0]!.body;
  fireEvent.click(screen.getByRole("button", { name: "Check current state" }));await screen.findByRole("checkbox");acknowledge();fireEvent.click(screen.getByRole("button", { name: "Retry same archive request" }));
  await screen.findByText("This submission was refused. No new archive was recorded by this submission. The earlier outcome for this request is still unconfirmed.");expect(f.posts()).toHaveLength(2);expect(f.posts()[1]!.body).toEqual(original);
 } finally { f.close(); }
});
it("resolves uncertainty only when the same request returns a validated receipt", async () => {
 let calls = 0, restored = false;const current = () => ({ orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", status: calls > 1 && !restored ? "archived" : "active", expectedRevision: restored ? 2 : calls > 1 ? 1 : 0, expectedProjectRevision: 3, checkedAt: "2026-10-27T17:22:00.000Z", access: { actions: calls > 1 && !restored ? [] : ["archive"] } });
 const f = mount({ preview: () => ({ status: 200, body: current() }), post: async () => { if (++calls === 1) throw new Error("Synthetic lost response");return { status: 200, body: { replayed: true, receipt: { project: "payments", status: "archived", revision: 1, projectRevision: 3, archivedAt: "2026-10-27T17:22:00.000Z", egressReconciliation: "pending" }, current: current(), effects: { egress: "not_attempted", archiveHook: "not_attempted" } } }; } });
 try { await review();acknowledge();fireEvent.click(screen.getByRole("button", { name: "Archive project" }));await screen.findByText(/outcome is unconfirmed/);const original = f.posts()[0]!.body;
  fireEvent.click(screen.getByRole("button", { name: "Check current state" }));await screen.findByRole("checkbox");acknowledge();fireEvent.click(screen.getByRole("button", { name: "Retry same archive request" }));await screen.findByText("Current project status: Archived.");expect(screen.getByText(/Original archive recorded/)).toBeTruthy();expect(screen.queryByText(/remains unconfirmed/)).toBeNull();expect(screen.queryByText(/outcome is unconfirmed/)).toBeNull();expect(f.posts()[1]!.body).toEqual(original);
  restored = true;fireEvent.click(screen.getByRole("button", { name: "Check current state" }));await screen.findByText("Current project status: Active.");fireEvent.click(screen.getByRole("button", { name: "Review latest state" }));await screen.findByRole("checkbox");expect(screen.queryByText(/remains unconfirmed/)).toBeNull();expect(f.posts()).toHaveLength(2);
 } finally { f.close(); }
});
it("focuses a stable pending status and keeps focus through archive completion", async () => {
 let resolve!:(r:ApiResponse)=>void;const f = mount({ post: () => new Promise<ApiResponse>(r => { resolve = r; }) });
 try { await review();acknowledge();const button = screen.getByRole("button", { name: "Archive project" });button.focus();fireEvent.click(button);
  const pending = await screen.findByRole("status", { name: "Archive request progress" });await waitFor(() => expect(document.activeElement).toBe(pending));expect(f.posts()).toHaveLength(1);
  await act(async () => { resolve({ status: 503, body: {} }); });await screen.findByText(/outcome is unconfirmed/);expect(document.activeElement).toBe(pending);
 } finally { resolve?.({ status: 503, body: {} });f.close(); }
});
for (const malformed of [false, true]) it(`keeps an unrecognized ${malformed ? "malformed" : "typed"} 4xx outcome unconfirmed`, async () => {
 const f = mount({ post: async () => ({ status: malformed ? 404 : 403, body: malformed ? "Synthetic proxy response" : { error: { code: "FUTURE_REFUSAL", message: "private unrecognized detail" } } }) });
 try { await review();acknowledge();fireEvent.click(screen.getByRole("button", { name: "Archive project" }));await screen.findByText(/outcome is unconfirmed/);expect(screen.queryByText(/No new archive was recorded/)).toBeNull();expect(f.posts()).toHaveLength(1);expect(document.body.textContent).not.toContain("private unrecognized detail"); } finally { f.close(); }
});
it("does not resolve an older ambiguous UUID when a different fresh request gets a receipt", async () => {
 let calls = 0, revision = 0, archived = false;
 const current = () => ({ orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", status: archived ? "archived" : "active", expectedRevision: revision, expectedProjectRevision: 3, checkedAt: "2026-10-27T17:22:00.000Z", access: { actions: archived ? [] : ["archive"] } });
 const f = mount({ preview: () => ({ status: 200, body: current() }), post: async () => { if (++calls === 1) throw new Error("Synthetic lost response");archived = true;revision++;return { status: 200, body: { replayed: false, receipt: { project: "payments", status: "archived", revision, projectRevision: 3, archivedAt: "2026-10-27T17:22:00.000Z", egressReconciliation: "pending" }, current: current(), effects: { egress: "synchronized", archiveHook: "not_configured" } } }; } });
 try {
  await review();acknowledge();fireEvent.click(screen.getByRole("button", { name: "Archive project" }));await screen.findByText(/outcome is unconfirmed/);const original = f.posts()[0]!.body as Record<string, unknown>;
  revision = 2;fireEvent.click(screen.getByRole("button", { name: "Check current state" }));await screen.findByRole("button", { name: "Review latest state" });fireEvent.click(screen.getByRole("button", { name: "Review latest state" }));await screen.findByRole("checkbox");acknowledge();await waitFor(() => expect(screen.getByRole("button", { name: "Archive project" })).toHaveProperty("disabled", false));fireEvent.click(screen.getByRole("button", { name: "Archive project" }));
  await screen.findByText("Current project status: Archived.");expect(screen.getByText(/Original archive recorded/)).toBeTruthy();expect(screen.getByText("An earlier archive request remains unconfirmed. Reviewing new state does not confirm its outcome.")).toBeTruthy();expect((f.posts()[1]!.body as Record<string, unknown>).requestId).not.toBe(original.requestId);
 } finally { f.close(); }
});
for (const code of ["CHANGE_STALE", "FORBIDDEN"]) it(`keeps a server failure with ${code} copy unconfirmed`, async () => {
 const f = mount({ post: async () => ({ status: 503, body: { error: { code, message: "Synthetic server failure" } } }) });
 try { await review();acknowledge();fireEvent.click(screen.getByRole("button", { name: "Archive project" }));await screen.findByText(/outcome is unconfirmed/);expect(screen.queryByText(/No new archive was recorded/)).toBeNull();expect(screen.queryByRole("button", { name: "Review latest state" })).toBeNull();expect(f.posts()).toHaveLength(1); } finally { f.close(); }
});

// B9 review Important 1: a failed read must not announce a nonexistent write.
for (const failure of ["invalid-preview", "read-refusal"]) it(`uses neutral completion wording for ${failure} without submitting an archive`, async () => {
 const f = mount({ preview: () => failure === "invalid-preview" ? { status: 200, body: { project: "payments" } } : { status: 403, body: { error: { code: "FORBIDDEN", message: "private synthetic read refusal" } } } });
 try {
  fireEvent.click(await screen.findByRole("button", { name: "Review archive" }));await screen.findByText("Couldn't check this project. Refresh and review before archiving.");
  const progress = screen.getByRole("status", { name: "Archive request progress" });expect(progress.textContent).toBe("Check finished. See the result below.");expect(progress.textContent).not.toMatch(/submission/i);expect(f.posts()).toHaveLength(0);
  const check = screen.getByRole("button", { name: "Check current state" });await waitFor(() => expect(check).toHaveProperty("disabled", false));fireEvent.click(check);await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.path.endsWith("/archive-preview"))).toHaveLength(2));await waitFor(() => expect(progress.textContent).toBe("Check finished. See the result below."));expect(f.posts()).toHaveLength(0);expect(document.body.textContent).not.toContain("private synthetic read refusal");
 } finally { f.close(); }
});
