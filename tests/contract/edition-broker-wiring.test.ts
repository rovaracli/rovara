import { describe, expect, it } from "vitest";
import { InstallInfoSchema, editionPolicy, installInfo } from "@agentx/contracts";
import { loadTsaDeps } from "../../packages/broker/src/audit/tsa-client.js";
import { installEditionPolicy } from "../../packages/broker/src/aws/broker/edition-wiring.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";

// Enterprise foundations E2: the edition reaches the broker once, from the deploy stamp, and never from anything else.

function thrown(run: () => void): { code?: string; message: string } | undefined {
  try { run(); } catch (error) { return error as { code?: string; message: string }; }
  return undefined;
}

describe("installEditionPolicy (read once at cold start)", () => {
  it("no stamp is an existing install: no policy, never Enterprise, whatever the cloud flag says", () => {
    expect(installEditionPolicy({}, false)).toBeUndefined();
    expect(installEditionPolicy({}, true)).toBeUndefined();
    expect(installEditionPolicy({ ROVARA_EDITION: undefined }, false)).toBeUndefined();
  });

  it("a stamp gives the table's policy", () => {
    expect(installEditionPolicy({ ROVARA_EDITION: "enterprise" }, false)).toBe(editionPolicy("enterprise"));
    expect(installEditionPolicy({ ROVARA_EDITION: "public" }, true)).toBe(editionPolicy("public"));
  });

  it("refuses to start on a stamp that is not exactly enterprise or public (an empty one included)", () => {
    for (const value of ["", "Enterprise", "PUBLIC", "enterprise ", "private", "true"]) {
      expect(thrown(() => installEditionPolicy({ ROVARA_EDITION: value }, false))?.code, JSON.stringify(value)).toBe("CONFIG_INVALID");
    }
  });

  it("refuses to start when the stamp and the cloud flag disagree (Enterprise inside the hosted cloud, Public outside it)", () => {
    expect(thrown(() => installEditionPolicy({ ROVARA_EDITION: "enterprise" }, true))?.code).toBe("CONFIG_INVALID");
    expect(thrown(() => installEditionPolicy({ ROVARA_EDITION: "public" }, false))?.code).toBe("CONFIG_INVALID");
  });

  it("never derives the edition from the cloud flag", () => {
    // cloud true without a stamp must not become Public, and cloud false must not become Enterprise.
    expect(installEditionPolicy({}, true)).toBeUndefined();
    expect(installEditionPolicy({}, false)).toBeUndefined();
  });
});

describe("GET /v1/app/install", () => {
  for (const edition of ["enterprise", "public"] as const) {
    it(`answers the ${edition} table and nothing else`, async () => {
      const h = await createDeveloperTaskBroker({ brokerExtra: { editionPolicy: editionPolicy(edition) } });
      const answer = await h.dev(MAYA, "GET", "/v1/app/install");
      expect(answer.status).toBe(200);
      const body = { ...answer.body };
      delete body.requestId;
      expect(InstallInfoSchema.parse(body)).toEqual(installInfo(editionPolicy(edition)));
    });
  }

  it("is not found on an existing install with no stamp: it does not guess an edition", async () => {
    const h = await createDeveloperTaskBroker();
    const answer = await h.dev(MAYA, "GET", "/v1/app/install");
    expect(answer.status).toBe(404);
    expect(JSON.stringify(answer.body)).not.toContain("enterprise");
  });

  it("needs a signed-in caller", async () => {
    const h = await createDeveloperTaskBroker({ brokerExtra: { editionPolicy: editionPolicy("enterprise") } });
    const response = await h.handler({ version: "2.0", rawPath: "/v1/app/install", rawQueryString: "", headers: {}, requestContext: { requestId: "anonymous", http: { method: "GET" } } });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toContain("features");
  });

  it("is a read: a POST does not answer it", async () => {
    const h = await createDeveloperTaskBroker({ brokerExtra: { editionPolicy: editionPolicy("enterprise") } });
    expect((await h.dev(MAYA, "POST", "/v1/app/install", {})).status).toBeGreaterThanOrEqual(400);
  });
});

describe("the audit anchor refuses to start in an Enterprise install on the public timestamp authorities", () => {
  const base = { AUDIT_TSA_TIMEOUT_MS: "10000", AUDIT_TSA_SPACING_MS: "15000" };
  const deps = { readParameter: async () => "", fetch: (async () => { throw new Error("no network in this test"); }) as typeof fetch, log: () => undefined };

  it("refuses kind public when the stamp is enterprise", async () => {
    await expect(loadTsaDeps({ ...base, ROVARA_EDITION: "enterprise", AUDIT_TSA_KIND: "public" }, deps)).rejects.toThrow(/public timestamp authorities/);
  });

  it("starts on kind off or custom in Enterprise", async () => {
    expect((await loadTsaDeps({ ...base, ROVARA_EDITION: "enterprise", AUDIT_TSA_KIND: "off" }, deps)).settings.kind).toBe("off");
    const custom = await loadTsaDeps({ ...base, ROVARA_EDITION: "enterprise", AUDIT_TSA_KIND: "custom", AUDIT_TSA_URLS: "https://tsa.example.test/ts", AUDIT_TSA_ROOTS_PARAMETER: "/r" }, deps);
    expect(custom.settings.kind).toBe("custom");
  });

  it("leaves Public and installs with no stamp on the public authorities, as before", async () => {
    expect((await loadTsaDeps({ ...base, ROVARA_EDITION: "public", AUDIT_TSA_KIND: "public" }, deps)).settings.kind).toBe("public");
    expect((await loadTsaDeps({ ...base, AUDIT_TSA_KIND: "public" }, deps)).settings.kind).toBe("public");
  });

  it("does not let an unrecognised stamp pass for not-Enterprise", async () => {
    await expect(loadTsaDeps({ ...base, ROVARA_EDITION: "Enterprise", AUDIT_TSA_KIND: "public" }, deps)).rejects.toThrow();
  });
});
