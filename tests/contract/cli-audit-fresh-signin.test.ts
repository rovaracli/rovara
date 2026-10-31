// Owner decision 2026-10-31: starting an audit export needs a sign-in from the last 10 minutes, and the CLI prompts for it. `audit export` and `audit verify` (which starts an export) sign in
// again when the control plane says REAUTH_REQUIRED, and send the same request once more; they never sign in again for any other refusal, and never more than once.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { buildAuditFixture } from "../support/audit-bundle-fixture.js";

const URL_ = "https://abc123.execute-api.us-east-1.amazonaws.com";
const ISSUER = `${URL_}/v1/auth`;
const entry = { url: URL_, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
const EXPORT_ID = `aex_${"0123456789abcdef".repeat(2)}`;
const SIGNED = "https://signed.test/exports-bucket/org/aex.rovara-audit.json.gz?sig=abc";
const REAUTH_WORDS = "Sign in again to export the audit log.";
const configuration = {
  env: "staging", apiVersion: "1.0", issuer: ISSUER, authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`,
  revocationEndpoint: `${ISSUER}/revoke`, clientId: "agentx-cli", methods: { slack: false, oidc: null, cloud: { displayName: "Rovara" }, github: { displayName: "GitHub" } },
};
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const file = gzipSync(Buffer.from(JSON.stringify(buildAuditFixture().bundle)));
const SUMMARY = { fromSeq: 1, toSeq: 40, records: 40, sealedThroughSeq: 35, unsealedCount: 5, timestampedThrough: "2026-10-20T12:46:30.000Z", epochsWithoutTimestamp: [], coveredEpochs: [], unverifiedAuthorities: [], lockModes: ["COMPLIANCE"], bytes: file.length };
const ready = { exportId: EXPORT_ID, status: "ready", requestedBy: { kind: "member", id: "dev_1" }, range: { fromSeq: 1, toSeq: 40 }, withDetails: false, createdAt: "2026-10-20T14:00:00.000Z", completedAt: "2026-10-20T14:01:00.000Z", expiresAt: "2026-10-26T14:01:00.000Z", summary: SUMMARY, download: { url: SIGNED, expiresInSeconds: 900 } };

async function cli(startAnswer: (authorization: string | null, attempt: number) => Response) {
  const home = await mkdtemp(join(tmpdir(), "rovara-audit-fresh-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "staging", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "access", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const startBodies: unknown[] = [];
  let attempts = 0;
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(href).pathname;
    const method = init?.method ?? "GET";
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push(`${method} ${href === SIGNED ? "(signed link)" : path} ${authorization ?? ""}`.trim());
    if (path === "/v1/auth/.well-known/agentx-configuration") return Response.json(configuration);
    if (path === "/v1/auth/token") return Response.json({ access_token: "access2", token_type: "Bearer", expires_in: 3600, refresh_token: `agxr_${"b".repeat(43)}` });
    if (method === "POST" && path === "/v1/dev/org/audit/exports") { startBodies.push(JSON.parse(init?.body as string)); attempts += 1; return startAnswer(authorization, attempts); }
    if (method === "GET" && path.startsWith("/v1/dev/org/audit/exports/")) return Response.json(ready);
    if (href === SIGNED) return new Response(new Uint8Array(file));
    return new Response("unexpected", { status: 500 });
  });
  const opened: string[] = [];
  const openBrowser = vi.fn(async (link: string) => {
    opened.push(link);
    const authorize = new URL(link);
    const redirect = authorize.searchParams.get("redirect_uri");
    if (redirect === null) return;
    const callback = new URL(redirect);
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    callback.searchParams.set("code", "agxc_code");
    await fetch(callback);
  });
  const run = (args: string[]) => executeCli(["--config-dir", home, "--allow-loopback", ...args], {
    fetchImplementation, tokenStore, environments: { home }, login: { openBrowser },
    stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) },
    audit: { sleep: async () => undefined, newRequestId: () => "11111111-1111-4111-8111-111111111111" },
  });
  return { run, out, err, calls, opened, startBodies, home };
}
const reauth = () => Response.json({ error: { code: "REAUTH_REQUIRED", message: REAUTH_WORDS } }, { status: 403 });
const started = () => Response.json({ exportId: EXPORT_ID, status: "ready" }, { status: 202 });

describe("agentx audit export needs a fresh sign-in", () => {
  it("signs in again when the control plane asks, then sends the same request once more and saves the export", async () => {
    const h = await cli((authorization) => (authorization === "Bearer access2" ? started() : reauth()));
    const out = join(h.home, "audit.json.gz");
    expect(await h.run(["audit", "export", "--from", "1", "--to", "40", "--out", out])).toBe(0);
    expect(h.calls.filter((call) => call.startsWith("POST /v1/dev"))).toEqual(["POST /v1/dev/org/audit/exports Bearer access", "POST /v1/dev/org/audit/exports Bearer access2"]);
    // The prompt asks the provider to ask again (not reuse a browser session), says why, and the second request is the same export.
    expect(h.opened).toHaveLength(1);
    expect(new URL(h.opened[0]!).searchParams.get("fresh")).toBe("1");
    expect(h.err.join("")).toContain(REAUTH_WORDS);
    expect(h.err.join("")).toContain("Signing in again");
    expect(h.startBodies[1]).toEqual(h.startBodies[0]);
    expect(h.out.join("")).toContain(`Saved the export to ${out}`);
  });

  it("asks for a sign-in once only: a second refusal is shown as it is", async () => {
    const h = await cli(() => reauth());
    expect(await h.run(["audit", "export", "--from", "1", "--to", "40", "--out", join(h.home, "x.json.gz")])).not.toBe(0);
    expect(h.calls.filter((call) => call.startsWith("POST /v1/dev"))).toHaveLength(2);
    expect(h.opened).toHaveLength(1);
    expect(h.err.join("")).toContain(REAUTH_WORDS);
  });

  it("does not sign in again for a refusal that is not a request for one, or when none is needed", async () => {
    const forbidden = await cli(() => Response.json({ error: { code: "FORBIDDEN", message: "Only owners and admins can export." } }, { status: 403 }));
    expect(await forbidden.run(["audit", "export", "--from", "1", "--to", "40", "--out", join(forbidden.home, "x.json.gz")])).not.toBe(0);
    expect(forbidden.opened).toEqual([]);
    expect(forbidden.calls.filter((call) => call.startsWith("POST /v1/dev"))).toHaveLength(1);
    const fresh = await cli(() => started());
    expect(await fresh.run(["audit", "export", "--from", "1", "--to", "40", "--out", join(fresh.home, "y.json.gz")])).toBe(0);
    expect(fresh.opened).toEqual([]);
  });

  it("verify starts an export too, so it asks for the same sign-in", async () => {
    const h = await cli((authorization) => (authorization === "Bearer access2" ? started() : reauth()));
    await h.run(["audit", "verify", "--from", "1", "--to", "40"]);
    expect(h.opened).toHaveLength(1);
    expect(h.calls.filter((call) => call.startsWith("POST /v1/dev"))).toEqual(["POST /v1/dev/org/audit/exports Bearer access", "POST /v1/dev/org/audit/exports Bearer access2"]);
  });
});
