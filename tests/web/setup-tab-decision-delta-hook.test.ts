// @vitest-environment jsdom
// Delta re-check of f73eabdea (reviewer-written): slow decision responses landing after the card moved on.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const hoisted = vi.hoisted(() => ({ api: { decide: undefined as unknown as (...a: unknown[]) => Promise<unknown>, discard: undefined as unknown as (...a: unknown[]) => Promise<unknown> } }));
vi.mock("../../packages/ui/src/api/setup-agent.js", async importOriginal => ({ ...(await importOriginal<object>()), useSetupAgentApi: () => hoisted.api }));
afterEach(cleanup);

describe("the decision follows its approval (hook, slow responses)", () => {
  const A = { requestId: "a", revision: 1, artifactDigest: "d1", kind: "setup", risk: "low" };
  const B = { requestId: "b", revision: 2, artifactDigest: "d2", kind: "setup", risk: "low" };
  const view = (approval?: typeof A) => (approval === undefined ? undefined : { approval, canApprove: true, canReject: true }) as never;
  it("a slow success for A that lands after the card shows B does not disable B; a slow failure for A shows no problem under B", async () => {
    const { useSetupDecision } = await import("../../packages/ui/src/screens/setup-tab/use-decision.js");
    let resolveA!: (v: unknown) => void, rejectA!: (e: unknown) => void;
    hoisted.api.decide = vi.fn(() => new Promise((res, rej) => { resolveA = res; rejectA = rej; }));
    hoisted.api.discard = vi.fn(async () => ({ discarded: true }));
    const initialProps: { ap: typeof A | undefined } = { ap: A };
    const hook = renderHook(({ ap }) => useSetupDecision("payments", view(ap), () => undefined), { initialProps });
    let p!: Promise<void>;
    act(() => { p = hook.result.current.decide("approve"); });
    expect(hook.result.current.busy).toBe("approve");
    hook.rerender({ ap: B });
    await act(async () => { resolveA({ decision: "approved" }); await p; });
    expect(hook.result.current.done).toBe(false);          // B is not decided
    hook.rerender({ ap: A });
    expect(hook.result.current.done).toBe(true);           // A still is
    hook.rerender({ ap: undefined });
    hook.rerender({ ap: A });
    expect(hook.result.current.done).toBe(false);          // gone from the read: forgotten
    // slow failure for A, card moves to B
    const { ApiError } = await import("../../packages/ui/src/api/errors.js");
    act(() => { p = hook.result.current.decide("approve"); });
    hook.rerender({ ap: B });
    await act(async () => { rejectA(new ApiError(409, "CHANGE_STALE", "moved")); await p; });
    expect(hook.result.current.problem).toBeUndefined();
    hook.rerender({ ap: A });
    expect(hook.result.current.problem?.message).toBe("moved");
    hook.unmount();
  });
});
