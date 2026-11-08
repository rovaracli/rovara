// Saved project images (SV wiring, switch `sv`): the project's Environment panel and its Reset, through the whole broker with live browser sessions. Browser only (a token is refused for every method), the
// maintainer role comes from the session's person, a write needs the same CSRF header as every /v1/app write, and the switch off means the paths do not exist.
import { afterEach, describe, expect, it } from "vitest";
import { SavedEnvPanelSchema, SavedEnvResetAnswerSchema } from "@agentx/contracts";
import { APP_CSRF_HEADER, appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { NAME, setupWizardBench } from "../support/setup-wizard-testenv.js";
import { TEST_ORG } from "../support/orgs.js";
import { DEV_ISSUER } from "../support/developer-task-broker.js";
import { imageOf, dig, savedEnvWorld } from "../support/saved-env-world.js";

afterEach(() => { delete process.env.SAVED_ENV_ENABLED; });
const PATH = `/v1/app/projects/${NAME}/environment-image`;
const DEV_ORIGIN = new URL(DEV_ISSUER).origin;
const SETTING = `${PATH}/setting`;
/** The route's answer without the envelope's request id. */
const answer = (body: Record<string, unknown>): Record<string, unknown> => { const { requestId: _id, ...rest } = body; void _id; return rest; };
const on = () => { process.env.SAVED_ENV_ENABLED = "1"; };

async function bench(options: { maya?: "viewer" | "contributor" | "maintainer" | "none" } = {}) {
  const w = savedEnvWorld({ ids: { orgId: TEST_ORG, projectId: NAME }, now: Date.now() });
  const t = await setupWizardBench({ brokerExtra: { savedEnvDeps: w.deps } });
  if (options.maya !== undefined && options.maya !== "none") await t.person(MAYA, "member", options.maya);
  else if (options.maya === "none") await t.person(MAYA, "member");
  return { t, w };
}

describe("behind sv", () => {
  it("every path is not found unless the switch is exactly 1, and nothing is written", async () => {
    const { t, w } = await bench();
    for (const value of [undefined, "0", "true", " 1"]) {
      if (value === undefined) delete process.env.SAVED_ENV_ENABLED; else process.env.SAVED_ENV_ENABLED = value;
      expect((await t.web(OMAR, "GET", PATH)).status, String(value)).toBe(404);
      expect((await t.web(OMAR, "POST", PATH, { action: "reset", requestId: "abcdefgh1234" })).status).toBe(404);
      expect((await t.web(OMAR, "PUT", SETTING, { enabled: false })).status).toBe(404);
    }
    expect(w.store.rows.size).toBe(0);
    expect(w.store.log).toEqual([]);
  });
});

describe("who may", () => {
  it("a token is refused for every method, before anything is read or written", async () => {
    const { t, w } = await bench();
    on();
    for (const [method, path, body] of [["GET", PATH, undefined], ["POST", PATH, { action: "reset", requestId: "abcdefgh1234" }], ["PUT", SETTING, { enabled: false }]] as const) {
      const reply = await t.dev(OMAR, method, path, body);
      expect(reply.status, `${method} ${path}`).toBe(403);
      expect(JSON.stringify(reply.body)).toContain("Use a live browser session");
    }
    expect(w.store.rows.size).toBe(0);
    expect(w.store.log).toEqual([]);
  });

  it("a member with no role on the project learns nothing about it", async () => {
    const { t, w } = await bench({ maya: "none" });
    on();
    expect((await t.web(MAYA, "GET", PATH)).status).toBe(404);
    expect((await t.web(MAYA, "POST", PATH, { action: "reset", requestId: "abcdefgh1234" })).status).toBe(404);
    expect(w.store.log).toEqual([]);
  });

  it("a viewer and a contributor read the panel but cannot Reset or change the setting: nothing is written or audited", async () => {
    for (const role of ["viewer", "contributor"] as const) {
      const { t, w } = await bench({ maya: role });
      on();
      const panel = await t.web(MAYA, "GET", PATH);
      expect(panel.status).toBe(200);
      expect(SavedEnvPanelSchema.parse(answer(panel.body))).toMatchObject({ canReset: false, canChangeSetting: false, enabled: true });
      expect((await t.web(MAYA, "POST", PATH, { action: "reset", requestId: "abcdefgh1234" })).status, role).toBe(403);
      expect((await t.web(MAYA, "PUT", SETTING, { enabled: false })).status, role).toBe(403);
      expect(w.store.rows.size).toBe(0);
      expect(w.store.log).toEqual([]);
    }
  });
});

describe("the panel and Reset", () => {
  it("shows the panel to a maintainer, who can reset; the reset queues a rebuild and is audited with the person; the same press again is one press", async () => {
    const { t, w } = await bench({ maya: "maintainer" });
    on();
    w.seed({ images: [imageOf(dig(1))], health: "healthy" });
    const before = await t.web(MAYA, "GET", PATH);
    expect(SavedEnvPanelSchema.parse(answer(before.body))).toMatchObject({ health: "healthy", canReset: true, image: { status: "ready" } });
    const press = await t.web(MAYA, "POST", PATH, { action: "reset", requestId: "press-0001-aaaa" });
    expect(press.status, JSON.stringify(press.body)).toBe(200);
    expect(SavedEnvResetAnswerSchema.parse(answer(press.body))).toMatchObject({ status: "queued", panel: { rebuild: { state: "queued", reason: "reset" } } });
    expect(w.row()?.job?.reason).toBe("reset");
    const asked = w.store.log.filter((entry) => entry.action === "reset_requested");
    expect(asked).toEqual([expect.objectContaining({ actor: MAYA.developerId, orgId: TEST_ORG, projectId: NAME })]);
    const again = await t.web(MAYA, "POST", PATH, { action: "reset", requestId: "press-0001-aaaa" });
    expect(SavedEnvResetAnswerSchema.parse(answer(again.body)).status).toBe("queued");
    expect(w.store.log.filter((entry) => entry.action === "reset_requested")).toHaveLength(1);
  });

  it("an org owner counts as a maintainer; a body that is not the one action is refused with field names only", async () => {
    const { t } = await bench();
    on();
    expect(SavedEnvPanelSchema.parse(answer((await t.web(OMAR, "GET", PATH)).body)).canReset).toBe(true);
    for (const body of [{ action: "reset" }, { action: "reset", requestId: "abcdefgh1234", extra: 1 }, { action: "shrug", requestId: "abcdefgh1234" }, { action: "reset", requestId: "has space!" }]) {
      expect((await t.web(OMAR, "POST", PATH, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("refuses a write without the app's CSRF header or with a wrong one, like every /v1/app write, and writes nothing", async () => {
    const { t, w } = await bench({ maya: "maintainer" });
    on();
    const session = t.browserSessionOf(MAYA);
    const send = (csrf: string | undefined) => t.handler({
      rawPath: PATH.replace("/v1/app/", "/v1/web/"), rawQueryString: "", routeKey: "ANY /v1/web/{proxy+}",
      headers: { cookie: `__Host-agentx_review_session=${session}`, "sec-fetch-site": "same-origin", origin: DEV_ORIGIN, ...(csrf === undefined ? {} : { [APP_CSRF_HEADER]: csrf }) },
      body: JSON.stringify({ action: "reset", requestId: "press-0002-aaaa" }), requestContext: { requestId: "r", http: { method: "POST" } },
    });
    expect((await send(undefined)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await send("not-the-token")).statusCode).toBeGreaterThanOrEqual(400);
    expect(w.store.rows.size).toBe(0);
    expect(w.store.log).toEqual([]);
    // the same request with the right token is accepted
    expect((await send(appCsrfTokenFor(session))).statusCode).toBe(200);
    expect(w.store.log.filter((entry) => entry.action === "reset_requested")).toHaveLength(1);
  });
});

describe("the project's setting", () => {
  it("a maintainer turns saved images off and on; the change is audited with the person and the value; a change to the same value writes nothing", async () => {
    const { t, w } = await bench({ maya: "maintainer" });
    on();
    expect(await t.web(MAYA, "PUT", SETTING, { enabled: true })).toMatchObject({ status: 200, body: { enabled: true, changed: false } });
    expect(w.store.log).toEqual([]);
    expect(await t.web(MAYA, "PUT", SETTING, { enabled: false })).toMatchObject({ status: 200, body: { enabled: false, changed: true } });
    expect(w.row()?.enabled).toBe(false);
    // the panel says it is off, and still offers the maintainer the control (SV-1l)
    expect(await t.web(MAYA, "GET", PATH)).toMatchObject({ status: 200, body: { enabled: false, canChangeSetting: true } });
    expect(w.store.log).toEqual([expect.objectContaining({ action: "setting_changed", enabled: false, actor: MAYA.developerId })]);
    // a project turned off queues nothing
    expect(await t.web(MAYA, "POST", PATH, { action: "reset", requestId: "press-0003-aaaa" })).toMatchObject({ status: 200, body: { status: "nothing_to_do" } });
    expect(await t.web(MAYA, "PUT", SETTING, { enabled: true })).toMatchObject({ body: { changed: true } });
    expect((await t.web(MAYA, "PUT", SETTING, { enabled: "yes" })).status).toBe(400);
  });
});
