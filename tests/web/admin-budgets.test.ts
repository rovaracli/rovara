// @vitest-environment jsdom
import { it, expect } from "vitest";
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
// Match json-reply.ts, including gateway overwrite of a route's own requestId.
function gatewayHost(...args: Parameters<typeof fakeHost>) {
 const f = fakeHost(...args);
 f.host.transport.request = async input => {
  const response = await f.request(input), body = response.body;
  return response.status === 200 && body !== null && typeof body === "object" && !Array.isArray(body) ? { ...response, body: { ...body, requestId: "mock-gateway-request" } } : response;
 };
 return f;
}
const settings = { month: "2026-11", spentThisMonthUsd: 20, remainingUsd: 78, heldUsd: 2, limitUsd: 100, provisionalMicros: 1_230_000 };
function mount(options:{role?:string;respond?:(r:ApiRequest)=>Promise<ApiResponse>;theme?:"light"|"dark";width?:number}={}){
 const nav=AppNavSchema.parse({me:{developerId,name:"Priya",orgRole:"owner"},org:{name:"Acme"},homeCount:0,projects:[],shared:{agents:[],sessions:[]},features:{admin:true,localAgents:false,usage:false,chains:false,describe:false,notices:false}}),me={developer:{id:developerId,name:"Priya",orgRole:options.role??"owner"},org:{orgId,name:"Acme",plan:"team"},identities:[]};
 const f=gatewayHost(async r=>r.path.endsWith("/me")?{status:200,body:me}:r.path.endsWith("/nav")?{status:200,body:nav}:r.path.startsWith("/v1/app/inbox")?{status:501,body:{error:{code:"NOT_IMPLEMENTED",message:"Your inbox isn't available on this install yet."}}}:options.respond?.(r)??{status:200,body:r.path.endsWith("/org/spend") ? settings : {}});if(options.width!==undefined)f.host.viewport={width:()=>options.width??1280,subscribe:()=>()=>undefined};f.storage.set("rovara.theme",options.theme??"light");const query=createQueryClient();query.setQueryData(["nav"],nav);const router=createMemoryRouter(appRoutes(nav.features),{initialEntries:["/app/admin/money/budgets"]});const view=renderUi(h(AppHostProvider,{host:f.host,children:h(QueryClientProvider,{client:query,children:h(ThemeProvider,{host:f.host,children:h(RouterProvider,{router})})})}));return{...f,...view,query,router,me,close(){view.unmount();router.dispose();query.clear();}};
}

for (const role of ["owner", "admin"]) it(`shows ${role} the company month totals without the duplicate table or dead editor`, async () => {
 const f = mount({ role }); try {
  const group = await screen.findByRole("group", { name: "Spending in November" }); expect(group.textContent).toContain("$20.00"); expect(group.textContent).toContain("$78.00");
  expect(screen.getByText(/Not yet confirmed:/).textContent).toBe("Not yet confirmed: $1.23");
  expect(screen.getByText("Not yet confirmed amounts are already counted in Spent or Held.")).toBeTruthy();
  expect(screen.queryByText(/Spending by project/)).toBeNull(); expect(screen.queryByRole("region", { name: "By project" })).toBeNull();
  expect(screen.queryByRole("table", { name: "Monthly base budgets" })).toBeNull(); expect(screen.queryByText("Task stop")).toBeNull();
  expect(f.request.mock.calls.every(([r]) => r.method === "GET" && !/budget-settings|task-stop|enrollment/.test(r.path))).toBe(true);
 } finally { f.close(); }
});
for (const status of [403, 404, 429, 503]) it(`hides previous amounts after spending refresh fails with ${status}`, async () => {
 const f = mount(); try {
  await screen.findByText("$20.00");
  f.request.mockImplementation(async r => r.path.endsWith("/me") ? { status: 200, body: f.me } : { status, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "private detail" } } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh spending" }));
  await waitFor(() => expect(screen.queryByText("$20.00")).toBeNull()); expect(screen.queryByText("private detail")).toBeNull();
 } finally { f.close(); }
});
it("shows unknown provisional totals as unavailable rather than zero", async () => {
 const f = mount({ respond: async () => ({ status: 200, body: { spentThisMonthUsd: 0, limitUsd: 10, remainingUsd: 10 } }) });
 try { expect((await screen.findByText(/Not yet confirmed:/)).textContent).toBe("Not yet confirmed: Unavailable"); } finally { f.close(); }
});
for (const field of ["org", "person", "role"] as const) for (const late of [200, 401]) it(`discards late ${late} spending on a mounted ${field} change`, async () => {
 let resolve!: (value: ApiResponse) => void; const pending = new Promise<ApiResponse>(done => { resolve = done; });
 const f = mount({ respond: r => r.path.endsWith("/org/spend") ? pending : Promise.resolve({ status: 200, body: {} }) });
 try {
  await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path.endsWith("/org/spend"))).toBe(true));
  if (field === "org") f.me.org.orgId = "org_bbbbbbbbbbbbbbbbbbbb"; else if (field === "person") f.me.developer.id = "c".repeat(64); else f.me.developer.orgRole = "admin";
  f.request.mockImplementation(async r => r.path.endsWith("/me") ? { status: 200, body: f.me } : { status: 200, body: r.path.endsWith("/org/spend") ? { ...settings, spentThisMonthUsd: 7 } : {} });
  await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "identity"] }); }); await screen.findByText("$7.00");
  await act(async () => { resolve(late === 200 ? { status: 200, body: settings } : { status: 401, body: { error: { code: "AUTH_REQUIRED" } } }); });
  expect(screen.queryByText("$20.00")).toBeNull(); expect(f.host.signIn).not.toHaveBeenCalled();
  expect(f.query.getQueriesData({ queryKey: ["admin", "lane-c", "org-spend", orgId, developerId, "owner"] })).toEqual([]);
 } finally { f.close(); }
});
it("does not ask for financial data as a member", async () => {
 const f = mount({ role: "member" }); try { await screen.findByRole("heading", { name: "Administration unavailable" }); expect(f.request.mock.calls.some(([r]) => r.path.endsWith("/org/spend"))).toBe(false); } finally { f.close(); }
});
for (const theme of ["light", "dark"] as const) it(`has accessible spending totals in ${theme}`, async () => {
 const f = mount({ theme }); try { await screen.findByText("$20.00"); await expectNoAxeViolations(f.container); } finally { f.close(); }
});

it("shows an absent meter month calmly, with no amounts or error", async () => {
 const f = mount({ respond: async () => ({ status: 200, body: { month: "2026-11", empty: true } }) });
 try {
  await screen.findByText("No AI spending recorded yet this month");
  expect(screen.queryByTestId("spend-error")).toBeNull();
  expect(screen.queryByText(/\$0/)).toBeNull(); expect(screen.queryByRole("group", { name: "Spending in November" })).toBeNull();
 } finally { f.close(); }
});
it("shows a real meter read fault as an error, never an empty month or zero", async () => {
 const f = mount({ respond: async () => ({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "private fault" } } }) });
 try {
  expect((await screen.findByTestId("spend-error")).textContent).toContain("Couldn't load spending.");
  expect(screen.queryByText("No AI spending recorded yet this month")).toBeNull(); expect(screen.queryByText(/\$0/)).toBeNull();
 } finally { f.close(); }
});
