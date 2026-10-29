// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { useAgentMembers } from "../../packages/ui/src/screens/agents/agent-context.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";
function Probe() { const read = useAgentMembers(true);return h("div", {}, read.isError ? "Directory unavailable" : read.data?.members.map(p => p.name).join(",") ?? "Loading"); }
function mount() {
 const me = meFixture({ developer: { id: "a".repeat(64), name: "Priya", orgRole: "owner" } }), query = createQueryClient();let name = "First person";
 const f = fakeHost(async r => ({ status: 200, body: r.path === "/v1/app/me" ? me : { members: [{ developerId: "b".repeat(64), name, role: "member", email: "private@example.test", joinedAt: "2026-10-01", identities: ["cloud"] }] } }));
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Probe, {}) }) }));
 return { ...f, me, query, setName(value: string) { name = value; }, close() { view.unmount();query.clear(); } };
}
it("projects owner/admin directory data before it enters the agent cache", async () => {
 const f = mount();await screen.findByText("First person");const cached = f.query.getQueriesData({ queryKey: ["org", "members"] });
 expect(cached).toEqual([[["org", "members", f.me.org.orgId, f.me.developer.id], { members: [{ developerId: "b".repeat(64), name: "First person" }] }]]);f.close();
});
for (const change of ["org", "person"] as const) it(`never reuses the agent directory after a mounted ${change} change`, async () => {
 const f = mount();await screen.findByText("First person");const oldOrg = f.me.org.orgId, oldPerson = f.me.developer.id;
 if (change === "org") f.me.org.orgId = "org_bbbbbbbbbbbbbbbbbbbb";else f.me.developer.id = "c".repeat(64);f.setName("New scope");
 await act(async () => { await f.query.invalidateQueries({ queryKey: ["agent-directory", "identity"] }); });
 expect(await screen.findByText("New scope")).toBeTruthy();expect(screen.queryByText("First person")).toBeNull();
 await waitFor(() => expect(f.query.getQueryData(["org", "members", oldOrg, oldPerson])).toBeUndefined());
 expect(f.request.mock.calls.filter(([r]) => r.path === "/v1/app/org/members")).toHaveLength(2);f.close();
});
it("fails closed and removes cached people when identity revalidation fails", async () => {
 const f = mount();await screen.findByText("First person");f.request.mockResolvedValue({ status: 403, body: { error: { code: "FORBIDDEN", message: "refused" } } });
 await act(async () => { await f.query.invalidateQueries({ queryKey: ["agent-directory", "identity"] }); });
 expect(await screen.findByText("Directory unavailable")).toBeTruthy();expect(screen.queryByText("First person")).toBeNull();await waitFor(() => expect(f.query.getQueriesData({ queryKey: ["org", "members"] }).every(([, data]) => data === undefined)).toBe(true));f.close();
});
