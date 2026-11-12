// Convergence A2 (no traffic): Cloud's side of the outbox relay is off until a composition root installs it, and the schedule that calls it is DISABLED.
import { afterEach, describe, expect, it, vi } from "vitest";
import { installOutboxRelayBackstop, isOutboxRelayBackstopEvent, outboxRelayCompanies, runOutboxRelayBackstop } from "../../packages/broker/src/cloud-adapters/queue/outbox-relay-wiring.js";

afterEach(() => installOutboxRelayBackstop(undefined));

describe("the outbox relay backstop wiring", () => {
  it("recognises only its own schedule event", () => {
    expect(isOutboxRelayBackstopEvent({ source: "agentx.outbox-relay-backstop" })).toBe(true);
    for (const other of [null, undefined, "agentx.outbox-relay-backstop", {}, { source: "agentx.workflow-dispatch-recovery" }, { kind: "agentx.outbox-relay-backstop" }]) expect(isOutboxRelayBackstopEvent(other)).toBe(false);
  });

  it("does nothing, and says so, until a relay is installed (no traffic)", async () => {
    expect(await runOutboxRelayBackstop()).toEqual({ skipped: "not_wired" });
  });

  it("runs the installed relay and returns its report; a throw is logged by name only and not passed to the schedule", async () => {
    const report = { delivered: 2, failed: 0, dead: 0, companies: 1, deferred: 0, errors: 0 };
    installOutboxRelayBackstop(async () => report);
    expect(await runOutboxRelayBackstop()).toEqual(report);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    installOutboxRelayBackstop(async () => { throw new Error("secret detail with ORG#org_x"); });
    expect(await runOutboxRelayBackstop()).toEqual({ error: "relay_failed" });
    const logged = String(log.mock.calls[0]?.[0]);
    expect(logged).toContain("outbox_relay.backstop_failed");
    expect(logged).not.toContain("secret detail");
    log.mockRestore();
  });

  it("serves the install's one org", async () => {
    const companies = await outboxRelayCompanies({ AGENTX_ENV: "staging" })();
    expect(companies).toHaveLength(1);
    expect(companies[0]).toMatch(/^org_/);
  });
});
