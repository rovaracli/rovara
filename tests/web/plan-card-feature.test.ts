// @vitest-environment jsdom
// Lead 4 PCF: the feature line on a coding plan's card (the Home card and the task pane's "Your decision"), with "Change", "Make a new feature" and "No feature" for the person Code says may change it. A fake host answers as
// Cloud's three routes do; the page draws only what the card's `planFeature` says, asks Code's choices when "Change" is pressed, and shows Code's own words when it refuses.
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { readDecisions, type ReadDecision } from "../../packages/ui/src/api/decisions.js";
import { DecisionCard } from "../../packages/ui/src/design/DecisionCard.js";
import { PlanFeatureLine } from "../../packages/ui/src/design/PlanFeatureLine.js";
import { CARDS, ID, decisionsView } from "./support/work-fixture.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";

const FT = (letter: string) => `ft_${letter.repeat(20)}`;
const F_CHECKOUT = FT("1"), F_BILLING = FT("2");
const LINE = "Feature: Checkout v2 (from the Linear parent)";
const planFeature = (over: Record<string, unknown> = {}) => ({ line: LINE, feature: { id: F_CHECKOUT, name: "Checkout v2", source: "tracker" }, canChange: true, canCreate: false, ...over });
const decisionOf = (patch: Record<string, unknown>, which = 0): ReadDecision => {
  const cards = CARDS.map((entry, index) => (index === which ? { ...entry, ...patch } : entry));
  return readDecisions(DecisionCardsViewReaderSchema.parse(decisionsView(cards)))[which]!;
};
const actions = { onOpenEvidence: async () => undefined, onApprove: async () => ({ kind: "decided" as const, outcome: "approved" as const }), onReject: async () => ({ kind: "decided" as const, outcome: "rejected" as const }), onStale: () => undefined };
const CHOICES = { features: [{ id: F_CHECKOUT, name: "Checkout v2" }, { id: F_BILLING, name: "Billing" }], canCreate: false };

type Handle = (request: ApiRequest) => ApiResponse | undefined;
function setup(decision: ReadDecision, handle: Handle, variant: "home" | "pane" = "home") {
  const f = fakeHost(async (request) => handle(request) ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "nope" } } });
  const query = createQueryClient();
  const invalidated: string[] = [];
  const original = query.invalidateQueries.bind(query);
  query.invalidateQueries = ((filters?: { queryKey?: readonly unknown[] }) => { invalidated.push(String(filters?.queryKey?.[0])); return original(filters as never); });
  renderUi(h(MemoryRouter, null, h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(DecisionCard, { decision, actions, ...(variant === "pane" ? { pane: {} } : {}) }) }) })));
  return { f, invalidated };
}
const writes = (f: ReturnType<typeof fakeHost>) => f.request.mock.calls.map(([request]) => request).filter((request) => request.method !== "GET");
const reads = (f: ReturnType<typeof fakeHost>) => f.request.mock.calls.map(([request]) => request.path);

describe("the plan card's feature line", () => {
  for (const variant of ["home", "pane"] as const) {
    it(`${variant}: says the feature in one line, with Change and No feature for the person who may change it, and asks nothing until Change is pressed`, () => {
      const { f } = setup(decisionOf({ planFeature: planFeature() }), () => ({ status: 200, body: CHOICES }), variant);
      const box = screen.getByTestId("plan-feature");
      expect(within(box).getByText(LINE)).toBeTruthy();
      expect(within(box).getByRole("button", { name: "Change" })).toBeTruthy();
      expect(within(box).getByRole("button", { name: "No feature" })).toBeTruthy();
      expect(f.request).not.toHaveBeenCalled();
    });
  }

  it("a person who may not change it sees the line and no control, and nothing is asked", () => {
    const { f } = setup(decisionOf({ planFeature: planFeature({ canChange: false }) }), () => undefined);
    const box = screen.getByTestId("plan-feature");
    expect(within(box).getByText(LINE)).toBeTruthy();
    expect(within(box).queryAllByRole("button")).toHaveLength(0);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("a task with no feature has no No feature button; a card with no planFeature, a merge card and a decided plan card show no line", () => {
    setup(decisionOf({ planFeature: planFeature({ feature: null, line: "Feature: No feature" }) }), () => undefined);
    expect(within(screen.getByTestId("plan-feature")).queryByRole("button", { name: "No feature" })).toBeNull();
    expect(within(screen.getByTestId("plan-feature")).getByRole("button", { name: "Change" })).toBeTruthy();
  });

  it("draws nothing for a card that is not a pending plan card with a feature view (on either card)", () => {
    for (const variant of ["home", "pane"] as const) {
      for (const decision of [decisionOf({}), decisionOf({ planFeature: planFeature() }, 1), decisionOf({ status: "approved", actions: [], planFeature: planFeature() })]) {
        const { f } = setup(decision, () => undefined, variant);
        expect(screen.queryByTestId("plan-feature")).toBeNull();
        expect(f.request).not.toHaveBeenCalled();
        document.body.innerHTML = "";
      }
    }
  });

  it("the line itself draws nothing for a card of another kind or one that is decided, whoever mounts it", () => {
    const f = fakeHost(async () => ({ status: 200, body: {} }));
    for (const decision of [decisionOf({ planFeature: planFeature() }, 1), decisionOf({ status: "rejected", actions: [], planFeature: planFeature() })]) {
      renderUi(h(MemoryRouter, null, h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(PlanFeatureLine, { card: decision.card }) }) })));
      expect(screen.queryByTestId("plan-feature")).toBeNull();
      document.body.innerHTML = "";
    }
  });

  it("draws a feature name as text, never as markup", () => {
    setup(decisionOf({ planFeature: planFeature({ line: "Feature: <img src=x onerror=alert(1)> (chosen)" }) }), () => undefined);
    const box = screen.getByTestId("plan-feature");
    expect(box.querySelector("img")).toBeNull();
    expect(box.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("Change", () => {
  it("reads Code's open features for this task, files the one picked through the existing route, and reads the cards again", async () => {
    const { f, invalidated } = setup(decisionOf({ planFeature: planFeature() }), (request) => {
      if (request.method === "GET") return { status: 200, body: CHOICES };
      return { status: 200, body: { task: { taskId: ID.plan, feature: { id: F_BILLING, source: "chosen" } } } };
    });
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const select = await screen.findByLabelText("Feature");
    expect(reads(f)).toEqual([`/v1/app/tasks/${ID.plan}/feature-choices`]);
    expect(within(select).getAllByRole("option").map((option) => option.textContent).slice(1)).toEqual(["Checkout v2", "Billing"]);
    expect(select).toHaveProperty("value", F_CHECKOUT);
    fireEvent.change(select, { target: { value: F_BILLING } });
    fireEvent.click(screen.getByRole("button", { name: "Use this feature" }));
    await waitFor(() => expect(writes(f)).toHaveLength(1));
    expect(writes(f)[0]).toMatchObject({ method: "POST", path: `/v1/app/tasks/${ID.plan}/feature`, body: { feature: F_BILLING } });
    await waitFor(() => expect(invalidated).toContain("decisions"));
    expect(screen.getByRole("status").textContent).toContain("Saved.");
    expect(screen.queryByLabelText("Feature")).toBeNull();
  });

  it("says so when the company has no open features, and Cancel goes back", async () => {
    setup(decisionOf({ planFeature: planFeature() }), () => ({ status: 200, body: { features: [], canCreate: false } }));
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(await screen.findByText("This company has no open features yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use this feature" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
  });

  it("No feature files null in one press", async () => {
    const { f } = setup(decisionOf({ planFeature: planFeature() }), () => ({ status: 200, body: { task: { taskId: ID.plan, feature: null } } }));
    fireEvent.click(screen.getByRole("button", { name: "No feature" }));
    await waitFor(() => expect(writes(f)).toHaveLength(1));
    expect(writes(f)[0]).toMatchObject({ method: "POST", path: `/v1/app/tasks/${ID.plan}/feature`, body: { feature: null } });
  });

  it("shows Code's own words when it refuses, and keeps the line", async () => {
    setup(decisionOf({ planFeature: planFeature() }), () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "Only a project maintainer, owner or admin can move a task that already has a feature." } } }));
    fireEvent.click(screen.getByRole("button", { name: "No feature" }));
    const alert = await screen.findByTestId("plan-feature-error");
    expect(alert.textContent).toContain("Only a project maintainer, owner or admin can move a task that already has a feature.");
    expect(screen.getByText(LINE)).toBeTruthy();
  });

  it("a list that does not load says so in fixed words and does not open a picker", async () => {
    setup(decisionOf({ planFeature: planFeature() }), () => ({ status: 200, body: { features: "nope" } }));
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect((await screen.findByTestId("plan-feature-error")).textContent).toMatch(/unreadable|Reload|Couldn't/u);
    expect(screen.queryByLabelText("Feature")).toBeNull();
  });
});

describe("making a new feature", () => {
  const make = { status: 201, body: { feature: { id: FT("4"), name: "Checkout v3" } } };
  const answer = (request: ApiRequest): ApiResponse => request.method === "GET" ? { status: 200, body: { ...CHOICES, canCreate: true } } : request.path === "/v1/app/org/report/features" ? make : { status: 200, body: { task: { taskId: ID.plan, feature: { id: FT("4"), source: "moved" } } } };

  it("is offered only when the card and Code's list both say the person may: it makes the feature, then files the task under it", async () => {
    const { f } = setup(decisionOf({ planFeature: planFeature({ canCreate: true }) }), answer);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const field = await screen.findByLabelText("Or make a new feature");
    const make_ = screen.getByRole("button", { name: "Make it and use it" });
    expect(make_).toHaveProperty("disabled", true);
    fireEvent.change(field, { target: { value: "  Checkout v3 " } });
    fireEvent.click(make_);
    await waitFor(() => expect(writes(f)).toHaveLength(2));
    expect(writes(f).map((request) => [request.path, request.body])).toEqual([["/v1/app/org/report/features", { name: "Checkout v3" }], [`/v1/app/tasks/${ID.plan}/feature`, { feature: FT("4") }]]);
  });

  it("a card that does not say canCreate, or a list that does not, shows no way to make one", async () => {
    setup(decisionOf({ planFeature: planFeature({ canCreate: false }) }), answer);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await screen.findByLabelText("Feature");
    expect(screen.queryByLabelText("Or make a new feature")).toBeNull();
    document.body.innerHTML = "";
    setup(decisionOf({ planFeature: planFeature({ canCreate: true }) }), (request) => (request.method === "GET" ? { status: 200, body: CHOICES } : undefined));
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await screen.findByLabelText("Feature");
    expect(screen.queryByLabelText("Or make a new feature")).toBeNull();
  });
});
