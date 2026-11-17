// @vitest-environment jsdom
// L4-D2 (DEC 254z b): the setup approval card on the Setup step's run section. It shows the candidate's risk in plain words with the reason, a short list of what changed, who approves and how the
// check on a fresh workspace went; Approve and Reject only for a person the server says may give that answer (otherwise one line); a decision needs a fresh sign-in, then is sent bound to exactly the
// revision and digest the read offered (never shown); a moved candidate shows the server's fixed refusal and a Refresh. The server decides; these tests only watch what the page asks and says.
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { SetupAgentViewSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import SetupRunSection from "../../packages/ui/src/screens/setup/SetupRunSection.js";
import { riskReason } from "../../packages/ui/src/screens/setup/SetupApprovalCard.js";
import { APPROVAL_WORDS as T } from "../../packages/ui/src/screens/setup/words.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

afterEach(cleanup);
const ME = "a".repeat(64), DIGEST = "ab12".repeat(16), NONCE_KEY = "rovara.stepup.nonce";
const LIMITS = { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 };
const apply = (over: Record<string, unknown> = {}) => ({
  candidateRevision: 4, baseRevision: 3, setup: ["npm ci"], readiness: ["npm test", "npm run lint"], check: { status: "ready" }, risk: "low",
  changes: [{ area: "setup_commands", risk: "low" }, { area: "test_commands", risk: "low" }], approver: "maintainer", canApprove: true, canReject: true,
  approval: { requestId: `setup-${DIGEST.slice(0, 40)}-4`, revision: 4, artifactDigest: DIGEST, kind: "setup", risk: "low" }, ...over,
});
const view = (over: Record<string, unknown> = {}, applyOver: Record<string, unknown> | null = {}) => ({ status: "ready", basedOnRevision: 3, limits: LIMITS, canManage: true, ...(applyOver === null ? {} : { apply: apply(applyOver) }), ...over });

interface Options { read?: unknown; decide?: { status: number; body: unknown }; discard?: { status: number; body: unknown }; fresh?: boolean }
function mount(options: Options = {}) {
  let current: unknown = options.read ?? view();
  const f = fakeHost(async request => {
    if (request.path === "/v1/app/projects/web/setup-agent" && request.method === "GET") return { status: 200, body: { ...(current as object), requestId: "gw" } };
    if (request.path === "/v1/app/projects/web/setup-agent/journal") return { status: 200, body: { status: "ready", entries: [], hostAsks: [], requestId: "gw" } };
    if (request.path === "/v1/app/projects/web/setup-agent/decide") {
      const answer = options.decide ?? { status: 200, body: { project: "web", decision: "approved", risk: "low", revision: 4, replayed: false } };
      if (answer.status === 200) current = view({}, null);
      return { status: answer.status, body: answer.status === 200 ? { ...(answer.body as object), requestId: "gw" } : answer.body };
    }
    if (request.path === "/v1/app/projects/web/setup-agent/discard") {
      const answer = options.discard ?? { status: 200, body: { discarded: true } };
      if (answer.status === 200) current = view({}, null);
      return { status: answer.status, body: answer.status === 200 ? { ...(answer.body as object), requestId: "gw" } : answer.body };
    }
    return { status: 200, body: { requestId: "x" } };
  });
  if (options.fresh === true) f.storage.set(NONCE_KEY, JSON.stringify({ nonce: "n-1", at: Date.now() }));
  const onDecided = vi.fn();
  const query = createQueryClient();
  query.setQueryData(["nav"], { me: { developerId: ME, name: "Maya", orgRole: "owner" } });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/onboard?project=web&step=setup" + (options.fresh === true ? "&confirmed=n-1" : "")], children: h(SetupRunSection, { project: "web", settingsRevision: 3, onDecided }) }) }) }));
  return { ...f, onDecided, query, setCurrent(value: unknown) { current = value; }, close() { ui.unmount(); query.clear(); } };
}
const decides = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([r]) => r).filter(r => r.method === "POST" && r.path.endsWith("/setup-agent/decide"));
const card = async () => screen.findByTestId("setup-approval");

it("the schema reads the candidate the server sends and refuses a risk it does not know", () => {
  expect(SetupAgentViewSchema.parse(view()).apply?.risk).toBe("low");
  expect(() => SetupAgentViewSchema.parse(view({}, { risk: "extreme" }))).toThrow();
  expect(() => SetupAgentViewSchema.parse(view({}, { approval: { requestId: "task-1", revision: 4, artifactDigest: DIGEST, kind: "setup", risk: "low" } }))).toThrow();
});

it("low risk: shows the risk with its reason, the changes, the passed check and who approves; the commands are one click away and no digest is shown", async () => {
  const f = mount();
  const c = await card();
  expect(within(c).getByTestId("setup-approval-risk").textContent).toContain("Low risk");
  expect(within(c).getByTestId("setup-approval-risk").textContent).toContain(T.why.low);
  const changes = within(c).getByRole("list", { name: "What changed" });
  expect(within(changes).getAllByRole("listitem").map(li => li.textContent)).toEqual(["Setup commands: 1 to run", "Test commands: 2 to run"]);
  expect(within(c).getByText(T.check.ready)).toBeTruthy();
  expect(within(c).getByTestId("setup-approval-who").textContent).toBe(T.who.maintainer);
  expect(within(c).getByRole("button", { name: "Approve" })).toBeTruthy();
  expect(within(c).getByRole("button", { name: "Reject" })).toBeTruthy();
  expect((c.querySelector("details") as HTMLDetailsElement).open).toBe(false);
  expect(c.textContent).not.toContain(DIGEST);
  expect(c.textContent).not.toContain(DIGEST.slice(0, 12));
  await expectNoAxeViolations(c);
  f.close();
});

it("medium and high risk say why in plain words; high names the areas it reaches", async () => {
  expect(riskReason({ risk: "medium", changes: [{ area: "test_mocks", risk: "medium" }] })).toBe(T.why.medium);
  expect(riskReason({ risk: "high", changes: [{ area: "websites", risk: "high" }, { area: "setup_commands", risk: "low" }, { area: "dev_container", risk: "high" }] })).toBe("It changes allowed websites, the dev container.");
  expect(riskReason({ risk: "high", changes: [{ area: "setup_commands", risk: "low" }] })).toBe(T.why.highUnknown);
  const f = mount({ read: view({}, { risk: "high", approver: "admin", changes: [{ area: "websites", risk: "high" }, { area: "setup_commands", risk: "low" }] }) });
  const c = await card();
  expect(c.getAttribute("data-risk")).toBe("high");
  expect(within(c).getByTestId("setup-approval-risk").textContent).toContain("High risk");
  expect(within(c).getByTestId("setup-approval-risk").textContent).toContain("It changes allowed websites.");
  expect(within(c).getByTestId("setup-approval-who").textContent).toBe("A company owner or admin approves high-risk changes.");
  f.close();
});

it("shows at most five change lines first; the rest are in the details", async () => {
  const areas = ["setup_commands", "test_commands", "test_mocks", "websites", "registries", "integrations", "dev_container"] as const;
  const f = mount({ read: view({}, { risk: "high", approver: "admin", changes: areas.map(area => ({ area, risk: "high" })) }) });
  const c = await card();
  expect(within(within(c).getByRole("list", { name: "What changed" })).getAllByRole("listitem")).toHaveLength(5);
  expect(within(within(c).getByRole("list", { name: "More changes" })).getAllByRole("listitem").map(li => li.textContent)).toEqual(["Integrations changed", "The dev container changed"]);
  f.close();
});

it("a person who cannot approve gets no Approve button, only the one line; a maintainer who may reject still has Reject", async () => {
  const none = mount({ read: view({ canManage: false }, { risk: "high", approver: "admin", canApprove: false, canReject: false }) });
  let c = await card();
  expect(within(c).queryByRole("button")).toBeNull();
  expect(within(c).getByTestId("setup-approval-who").textContent).toBe(T.who.admin);
  none.close(); cleanup();
  const reject = mount({ read: view({}, { risk: "high", approver: "admin", canApprove: false, canReject: true }) });
  c = await card();
  expect(within(c).queryByRole("button", { name: "Approve" })).toBeNull();
  expect(within(c).getByRole("button", { name: "Reject" })).toBeTruthy();
  reject.close();
});

it("while the check runs there is no decision, only the waiting line and Discard for a manager; polling is on", async () => {
  const f = mount({ read: view({}, { check: { status: "checking" }, canApprove: false, canReject: false, approval: undefined }) });
  const c = await card();
  expect(within(c).getByText(T.check.checking)).toBeTruthy();
  expect(within(c).queryByRole("button", { name: "Approve" })).toBeNull();
  expect(within(c).queryByRole("button", { name: "Reject" })).toBeNull();
  expect(within(c).getByRole("button", { name: "Discard this setup" })).toBeTruthy();
  f.close();
});

it("a failed check says so, names the step, applied nothing, and offers Discard (a reader sees no Discard)", async () => {
  const f = mount({ read: view({}, { check: { status: "failed", failedStep: "npm test" }, canApprove: false, canReject: false, approval: undefined }) });
  const c = await card();
  expect(within(c).getByRole("alert").textContent).toContain(T.check.failed);
  expect(within(c).getByRole("alert").textContent).toContain("npm test");
  fireEvent.click(within(c).getByRole("button", { name: "Discard this setup" }));
  await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path.endsWith("/discard") && r.method === "POST")).toBe(true));
  const call = f.request.mock.calls.map(([r]) => r).find(r => r.path.endsWith("/discard"))!;
  expect(Object.keys(call.body as object)).toEqual(["requestId"]);
  expect(await screen.findByTestId("setup-decided")).toBeTruthy();
  expect(screen.getByTestId("setup-decided").textContent).toBe(T.discarded);
  f.close(); cleanup();
  const reader = mount({ read: view({ canManage: false }, { check: { status: "failed", failedStep: "npm test" }, canApprove: false, canReject: false, approval: undefined }) });
  expect(within(await card()).queryByRole("button", { name: "Discard this setup" })).toBeNull();
  reader.close();
});

it("Approve without a fresh sign-in sends the person to confirm it's them (no decision is sent); Reject does the same", async () => {
  const f = mount();
  const c = await card();
  expect(within(c).getByTestId("setup-approval-fresh").textContent).toBe(T.stepUp);
  fireEvent.click(within(c).getByRole("button", { name: "Approve" }));
  expect(f.host.signIn).toHaveBeenCalledTimes(1);
  const [path, options] = (f.host.signIn as unknown as { mock: { calls: Array<[string, { stepUp?: boolean }]> } }).mock.calls[0]!;
  expect(path).toMatch(/confirmed=[0-9a-f-]{36}/u);
  expect(options).toEqual({ stepUp: true });
  fireEvent.click(within(c).getByRole("button", { name: "Reject" }));
  expect(f.host.signIn).toHaveBeenCalledTimes(2);
  expect(decides(f)).toHaveLength(0);
  f.close();
});

it("after the fresh sign-in, Approve sends exactly the binding the read offered, then says it is approved and asks the page to read the project again", async () => {
  const f = mount({ fresh: true });
  const c = await card();
  expect(within(c).getByTestId("setup-approval-fresh").textContent).toBe(T.stepUpDone);
  fireEvent.click(within(c).getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(decides(f)).toHaveLength(1));
  expect(decides(f)[0]!.body).toEqual({ requestId: `setup-${DIGEST.slice(0, 40)}-4`, outcome: "approve", seen: { revision: 4, artifactDigest: DIGEST } });
  expect(decides(f)[0]!.retry).toBe("never");
  expect((await screen.findByTestId("setup-decided")).textContent).toBe(T.approved);
  expect(screen.queryByTestId("setup-approval")).toBeNull();
  expect(f.host.signIn).not.toHaveBeenCalled();
  expect(f.onDecided).toHaveBeenCalledTimes(1);
  f.close();
});

it("Reject sends the reject answer with the same binding and says the project keeps its setup", async () => {
  const f = mount({ fresh: true, decide: { status: 200, body: { project: "web", decision: "rejected", risk: "low", revision: 4, replayed: false } } });
  const c = await card();
  fireEvent.click(within(c).getByRole("button", { name: "Reject" }));
  await waitFor(() => expect(decides(f)).toHaveLength(1));
  expect(decides(f)[0]!.body).toMatchObject({ outcome: "reject", seen: { revision: 4, artifactDigest: DIGEST } });
  expect((await screen.findByTestId("setup-decided")).textContent).toBe(T.rejected);
  expect(f.onDecided).not.toHaveBeenCalled();
  f.close();
});

it("a sign-in the server finds too old asks again: the confirmation is forgotten and the next press goes to the sign-in", async () => {
  const f = mount({ fresh: true, decide: { status: 403, body: { error: { code: "REAUTH_REQUIRED", message: "Confirm it's you again, then try once more." } } } });
  const c = await card();
  fireEvent.click(within(c).getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(within(c).getByTestId("setup-approval-fresh").textContent).toBe(T.stepUpOld));
  fireEvent.click(within(c).getByRole("button", { name: "Approve" }));
  expect(f.host.signIn).toHaveBeenCalledTimes(1);
  expect(decides(f)).toHaveLength(1);
  f.close();
});

it("a moved candidate shows the fixed refusal and a Refresh that reads the run again", async () => {
  const stale = "This setup changed or is no longer waiting for a decision. Refresh to see where it stands.";
  const f = mount({ fresh: true, decide: { status: 409, body: { error: { code: "CHANGE_STALE", message: stale } } } });
  const c = await card();
  fireEvent.click(within(c).getByRole("button", { name: "Approve" }));
  const problem = await screen.findByTestId("setup-approval-problem");
  expect(problem.textContent).toContain(stale);
  const reads = () => f.request.mock.calls.filter(([r]) => r.method === "GET" && r.path.endsWith("/setup-agent")).length;
  const before = reads();
  f.setCurrent(view({}, { candidateRevision: 5, approval: { requestId: `setup-${"c".repeat(40)}-5`, revision: 5, artifactDigest: "c".repeat(64), kind: "setup", risk: "low" } }));
  fireEvent.click(within(problem).getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(reads()).toBeGreaterThan(before));
  // The next decision names the new candidate, never the old one.
  fireEvent.click(within(await card()).getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(decides(f)).toHaveLength(2));
  expect(decides(f)[1]!.body).toMatchObject({ seen: { revision: 5, artifactDigest: "c".repeat(64) } });
  f.close();
});

it("another refusal (a maintainer on a high-risk change) is shown as it comes, with no Refresh", async () => {
  const words = "This setup change reaches outside the project's commands (a website, a secret, a registry, an integration or something Rovara does not recognise), so a company owner or admin must approve it.";
  const f = mount({ fresh: true, decide: { status: 403, body: { error: { code: "FORBIDDEN", message: words } } } });
  fireEvent.click(within(await card()).getByRole("button", { name: "Approve" }));
  const problem = await screen.findByTestId("setup-approval-problem");
  expect(problem.textContent).toContain("company owner or admin must approve");
  expect(within(problem).queryByRole("button", { name: "Refresh" })).toBeNull();
  f.close();
});

it("no candidate waiting: no card, and the ordinary 'Use this setup' card shows when Rovara has a proposal", async () => {
  const f = mount({ read: view({}, null) });
  await screen.findByRole("region", { name: "Set up with Rovara" });
  expect(screen.queryByTestId("setup-approval")).toBeNull();
  f.close();
});

it("offers no decision before the check passed, even if the server's flags said yes (the page never trusts a flag alone)", async () => {
  const f = mount({ fresh: true, read: view({}, { check: { status: "checking" }, canApprove: true, canReject: true }) });
  const c = await card();
  expect(within(c).queryByRole("button", { name: "Approve" })).toBeNull();
  expect(within(c).queryByRole("button", { name: "Reject" })).toBeNull();
  f.close();
});
