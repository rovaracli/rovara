// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { issueDecisionRead, readDecisions, recordDecisionRead, recordDecisionReadFailure } from "../../packages/ui/src/api/decisions.js";
import { useDecisionActions } from "../../packages/ui/src/screens/home/NeedsYou.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import "./support/render.js";
import { h } from "./support/h.js";
const view = (JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8")) as { views: Record<string, unknown> }).views["fix_setup"];
for (const state of ["ready", "failed", "refused", "newer", "identity"] as const) it(`rejection rechecks the shared decision basis inside its claim: ${state}`, async () => {
 const decision = readDecisions(DecisionCardsViewReaderSchema.parse(view))[0]!, me = meFixture();
 const identity = { orgId: me.org.orgId, developerId: me.developer.id };
 let reads = 0, release: ((value: { status: number; body: unknown }) => void) | undefined;
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/me") { if (++reads === 2) return new Promise(resolve => { release = resolve; });return { status: 200, body: me }; }
  if (request.method === "GET") return { status: 200, body: view };
  return { status: 200, body: { cardId: decision.card.id, outcome: "rejected", remainingTabs: [] } };
 });
 const query = createQueryClient();
 const ui = renderHook(() => useDecisionActions(), { wrapper: ({ children }) => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children }) }) });
 try {
  const result = ui.result.current(decision).onReject("not_now").then(value => ({ value }), (failure: unknown) => ({ failure }));
  await waitFor(() => expect(release).toBeDefined());
  if (state === "failed" || state === "refused") recordDecisionReadFailure(identity, issueDecisionRead(), state === "refused");
  if (state === "newer") recordDecisionRead(identity, issueDecisionRead(), [{ ...decision, digest: "f".repeat(64) }]);
  release!({ status: 200, body: state === "identity" ? { ...me, developer: { ...me.developer, id: "f".repeat(64) } } : me });
  await act(async () => { await result; });
  const writes = f.request.mock.calls.filter(([request]) => request.method === "POST");
  expect(writes).toHaveLength(state === "ready" ? 1 : 0);
 } finally { ui.unmount();query.clear(); }
});
