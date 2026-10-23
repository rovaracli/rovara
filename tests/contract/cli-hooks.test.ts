// Plan 4 Task 19: `agentx project hooks …` against a fake control plane: the requests each command sends, what it prints, that a secret is read from a file and never from an
// argument, and that a secret Rovara made is printed once by the call that made it.
import { afterEach, describe, expect, it } from "vitest";
import { UUID, agentsCli, cleanHarnessDirs } from "../support/agents-cli-harness.js";

afterEach(cleanHarnessDirs);

const BASE = "/v1/app/projects/web/event-hooks";
const HOOK = `hk_${"a".repeat(26)}`;
const URL_OF = (source: string) => `https://abc123.execute-api.us-west-2.amazonaws.com/v1/hooks/${source}/${HOOK}`;
const TENANT = { organizationId: "11111111-1111-4111-8111-111111111111", teamId: "c408e946-78aa-4db8-923e-f78053dd954f" };
const hook = (source: string, extra: Record<string, unknown> = {}) => ({ hookId: HOOK, source, project: "web", status: "active", url: URL_OF(source), ...extra });

describe("agentx project hooks", () => {
  it("lists a project's hooks with their address and last delivery, and says how to add one when there are none", async () => {
    const h = await agentsCli({ [`GET ${BASE}`]: Response.json({ hooks: [hook("linear", { lastDeliveryAt: "2026-10-22T09:00:00.000Z" }), hook("datadog")] }) });
    expect(await h.run(["project", "hooks", "list", "web"])).toBe(0);
    expect(h.stdout()).toContain(`${HOOK}  linear  active  last delivery 2026-10-22T09:00:00.000Z`);
    expect(h.stdout()).toContain(URL_OF("linear"));
    expect(h.stdout()).toContain("no delivery yet");
    const none = await agentsCli({ [`GET ${BASE}`]: Response.json({ hooks: [] }) });
    expect(await none.run(["project", "hooks", "list", "web"])).toBe(0);
    expect(none.stdout()).toContain("has no event hooks");
    expect(none.stdout()).toContain("agentx project hooks create web");
  });

  it("creates a hook with the vendor's secret read from a file, and never prints that secret", async () => {
    const h = await agentsCli({ [`POST ${BASE}`]: Response.json({ hook: hook("linear"), url: URL_OF("linear") }, { status: 201 }) });
    const tenant = await h.file("tenant.json", TENANT);
    const secret = await h.file("secret.txt", "vendor-signing-secret-0123456789\n");
    expect(await h.run(["project", "hooks", "create", "web", "--source", "linear", "--tenant", tenant, "--secret-file", secret])).toBe(0);
    expect(h.calls).toEqual([{ method: "POST", path: BASE, query: "", body: { requestId: expect.stringMatching(UUID) as string, source: "linear", tenant: TENANT, secret: "vendor-signing-secret-0123456789" } }]);
    expect(h.stdout()).toContain(URL_OF("linear"));
    expect(h.stdout()).toContain("is not shown again");
    expect(h.stdout()).not.toContain("vendor-signing-secret");
  });

  it("prints the secret Rovara made once, neutralised for a terminal", async () => {
    const h = await agentsCli({ [`POST ${BASE}`]: Response.json({ hook: hook("datadog"), url: URL_OF("datadog"), secret: "made-by-rovara_0123456789\u001b[31m" }, { status: 201 }) });
    const tenant = await h.file("tenant.json", { datadogOrgId: "1234" });
    expect(await h.run(["project", "hooks", "create", "web", "--source", "datadog", "--tenant", tenant])).toBe(0);
    expect(h.calls[0]!.body).toEqual({ requestId: expect.stringMatching(UUID) as string, source: "datadog", tenant: { datadogOrgId: "1234" } });
    expect(h.stdout()).toContain("shown once");
    expect(h.stdout()).toContain("made-by-rovara_0123456789[U+001B][31m");
    expect(h.stdout()).not.toContain("\u001b");
  });

  it("refuses without a source, a readable tenant or a readable secret file, and sends nothing", async () => {
    const h = await agentsCli({});
    const tenant = await h.file("tenant.json", TENANT);
    expect(await h.run(["project", "hooks", "create", "web", "--tenant", tenant])).not.toBe(0);
    expect(await h.run(["project", "hooks", "create", "web", "--source", "linear"])).not.toBe(0);
    expect(await h.run(["project", "hooks", "create", "web", "--source", "linear", "--tenant", tenant, "--secret-file", `${h.home}/missing.txt`])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("rotates a hook, takes a vendor's new secret from a file, and says the old one keeps working for a day", async () => {
    const h = await agentsCli({ [`POST ${BASE}/${HOOK}/rotate`]: Response.json({ hook: hook("datadog"), url: URL_OF("datadog"), secret: "second-secret_0123456789" }) });
    expect(await h.run(["project", "hooks", "rotate", "web", HOOK])).toBe(0);
    expect(h.calls[0]).toEqual({ method: "POST", path: `${BASE}/${HOOK}/rotate`, query: "", body: { requestId: expect.stringMatching(UUID) as string } });
    expect(h.stdout()).toContain("second-secret_0123456789");
    expect(h.stdout()).toContain("24 hours");
    const secret = await h.file("new-secret.txt", "vendor-new-secret-0123456789");
    expect(await h.run(["project", "hooks", "rotate", "web", HOOK, "--secret-file", secret])).toBe(0);
    expect((h.calls[1]!.body as { secret: string }).secret).toBe("vendor-new-secret-0123456789");
  });

  it("says a repeated rotation was already made, and deletes a hook", async () => {
    const h = await agentsCli({
      [`POST ${BASE}/${HOOK}/rotate`]: Response.json({ hook: hook("datadog"), url: URL_OF("datadog"), replayed: true }),
      [`DELETE ${BASE}/${HOOK}`]: Response.json({ deleted: true }),
    });
    expect(await h.run(["project", "hooks", "rotate", "web", HOOK])).toBe(0);
    expect(h.stdout()).toContain("already made");
    expect(await h.run(["project", "hooks", "delete", "web", HOOK])).toBe(0);
    expect(h.calls[1]).toEqual({ method: "DELETE", path: `${BASE}/${HOOK}`, query: "", body: { requestId: expect.stringMatching(UUID) as string } });
    expect(h.stdout()).toContain(`Deleted hook ${HOOK}`);
  });

  it("prints a refusal as the broker wrote it", async () => {
    const h = await agentsCli({ [`POST ${BASE}`]: Response.json({ error: { code: "RUNTIME_UNAVAILABLE", message: "RUNTIME_UNAVAILABLE: pagerduty events are not available yet" } }, { status: 503 }) });
    const tenant = await h.file("tenant.json", { subdomain: "acme" });
    expect(await h.run(["project", "hooks", "create", "web", "--source", "pagerduty", "--tenant", tenant])).not.toBe(0);
    expect(h.stderr()).toContain("pagerduty events are not available yet");
  });
});
