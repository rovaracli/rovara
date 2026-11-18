// Contract v0 between Rovara Cloud's web app and Rovara Code (packages/contracts/src/code-contract-v0.ts): the tables are consistent, and the
// file stays free of imports so the same bytes can sit in both repositories.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_ROUTES, CODE_ROUTES, contractCounts, matchCodeRoute, pathParamNames, pathPattern } from "../../packages/contracts/src/code-contract-v0.js";

describe("code contract v0 tables", () => {
  it("has one entry per Code route id and one per method and path", () => {
    expect(new Set(CODE_ROUTES.map((route) => route.id)).size).toBe(CODE_ROUTES.length);
    expect(new Set(CODE_ROUTES.map((route) => `${route.method} ${route.path}`)).size).toBe(CODE_ROUTES.length);
  });

  it("has one entry per web app method and path, each backed only by known Code routes", () => {
    expect(new Set(APP_ROUTES.map((route) => `${route.method} ${route.path}`)).size).toBe(APP_ROUTES.length);
    const ids = new Set(CODE_ROUTES.map((route) => route.id));
    for (const route of APP_ROUTES) for (const id of route.codeRoutes) expect(ids.has(id)).toBe(true);
  });

  it("gives every served route evidence and every missing route none", () => {
    for (const route of CODE_ROUTES) {
      if (route.awsApi === "no" && !route.mainline) expect(route.evidence).toBe("none");
      else expect(route.evidence).not.toBe("none");
    }
  });

  it("makes each Code-owned must-pass web route name the Code route that backs it, except the ones Code has no route for yet", () => {
    const unbacked = APP_ROUTES.filter((route) => route.owner === "code" && route.screen !== "later" && route.codeRoutes.length === 0).map((route) => `${route.method} ${route.path}`);
    // Known gaps, to be given a Code route (or moved to Cloud) at the week-2 checkpoint.
    expect(unbacked.sort()).toEqual(["GET /v1/app/github/requests", "POST /v1/app/me/identities/github", "POST /v1/app/me/identities/slack", "POST /v1/app/projects/{p}/code/suggest"].sort());
  });

  it("counts what the report says", () => {
    const counts = contractCounts();
    expect(counts.neededServed + counts.neededMissing).toBe(counts.codeNeeded);
    // 26 routes answered from Code (including the company audit, which merges Cloud's own audit records with Code's engine records), the decision card routes (list, approve, request changes, reject, evidence opened: Cloud passes them to Code and answers
    // the 404 "cards are off" while Code has none), the realtime token stub that tells the app live updates are off, and the Conversation (#28: the timeline
    // from Code's task events, comments Cloud keeps itself: events, messages list and send, edit, delete).
    // Plus the twelve lessons routes (DEC 231): the inbox batch, the lists, Keep, Drop and the batch, retire and retire requests, the mode, Lessons used and not helpful.
    // Plus the eval confirm (DEC 253q d), forwarded to Code's own route as the person (501 until Code serves it).
    // Plus Connect GitHub (guided onboarding PR 2): connect, the callback's kept result, choose, and the company's connections.
    // Plus Add to Slack, the channel picker, Connect Linear and the team pick (guided onboarding PR 11): sixteen routes.
    // Plus a project's archive and restore (guided onboarding PR 17): the two previews, the two reviewed changes and the lifecycle read, as the person.
    // Plus the repository picker (guided onboarding PR 10).
    // Plus the company's AI model and a project's per-task limit (guided onboarding PR 15): both reads and both changes, as the person.
    // Plus the project setup checklist and its skips, and the hosted setup run's read, start, stop and journal (guided onboarding PR 9).
    // Plus disconnecting a GitHub account on the Connections page (guided onboarding PR 12b).
    // Plus the two inbox routes (web task channel K5): the person's own rows and marking them read; Cloud forwards them to Code's C7 inbox as the person (501 until Code serves it).
    // Plus the five People panel routes (web task channel K3): the list, the candidates, a role change, adding a person and taking ownership; the candidates and add need Code's C4.
    // Plus Connected sign-ins (DEC 254w, approved DEC 254zf): the list, Connect and Unlink, passed to Code's /v1/dev/me/sign-ins routes as the person.
    // Plus the project wiki's page list, one page and its cited files (lead 4 W5).
    // Plus the project machine-size read and stored-choice write (machine-size screen).
    // Plus the wiki's corrections: the notes, marks, approvals and the disputed list (lead 4 C1): 8 rows.
    // Plus the setup approval (L4-D2): confirm flips to answered here, discard and decide are added: 3.
    // Plus the wiki panel on the setup page: the file map, the build controls and the nightly upkeep switch (lead 4 W6): 11 rows.
    // Plus the Cost and time report (Feature A, slice A3): the report and a feature's page: 2 rows.
    // Plus the person's own sign-in factors (L4-MF4): the masked confirmation email and passkeys, as the person: 1 row.
    expect(counts.appCloudServerToday).toBe(127);
  });

  it("says no route is served from the laptop core: the ten whose code exists only there arrive with E2, with nothing to cite on the deployed API", () => {
    expect(CODE_ROUTES.every((route) => route.awsApi === "yes" || route.awsApi === "no")).toBe(true);
    const e2 = CODE_ROUTES.filter((route) => route.arrivesWith !== undefined).map((route) => route.id).sort();
    expect(e2).toEqual(["decisions.act", "decisions.list", "howWeWork.get", "playbook.get", "playbook.put", "scriptTokens.create", "scriptTokens.list", "scriptTokens.revoke", "tasks.answers", "tasks.evidence.get"].sort());
    for (const route of CODE_ROUTES.filter((entry) => entry.arrivesWith !== undefined)) {
      expect(route.awsApi).toBe("no");
      expect(route.mainline).toBe(false);
      expect(route.evidence).toBe("none");
      expect(route.arrivesWith).toMatch(/^E2 \(core on AWS\); laptop core: /u);
    }
    expect(contractCounts().neededArrivesWithE2).toBe(10);
  });

  it("keeps Code's routes under /v1/dev (and sign-in under /v1/auth), and Cloud's decision routes on the app side", () => {
    for (const route of CODE_ROUTES) expect(route.path.startsWith("/v1/dev/") || route.path.startsWith("/v1/auth/"), route.id).toBe(true);
    const decisions = APP_ROUTES.filter((route) => route.path.startsWith("/v1/app/decisions"));
    expect(decisions).toHaveLength(5);
    for (const route of decisions) expect(route.cloudServerToday).toBe(true);
  });

  it("matches a request to the most specific route and decodes its parameters", () => {
    expect(matchCodeRoute("GET", "/v1/dev/tasks/abc/plan")?.route.id).toBe("tasks.plan");
    expect(matchCodeRoute("GET", "/v1/dev/tasks/abc")?.params).toEqual({ taskId: "abc" });
    expect(matchCodeRoute("PUT", "/v1/dev/client/projects/my%20app/members/dev1")?.params).toEqual({ project: "my app", developerId: "dev1" });
    expect(matchCodeRoute("GET", "/v1/dev/client/projects/web")?.route.id).toBe("client.projects.get");
    expect(matchCodeRoute("GET", "/v1/dev/client/repositories")?.route.id).toBe("client.repositories.list");
    expect(matchCodeRoute("DELETE", "/v1/dev/tasks/abc")).toBeUndefined();
    expect(pathParamNames("/v1/dev/tasks/{taskId}/readers/{developerId}")).toEqual(["taskId", "developerId"]);
    expect(pathPattern("/v1/auth/.well-known/jwks.json").test("/v1/auth/xwell-known/jwks.json")).toBe(false);
  });

  it("has no imports, so it can be copied byte for byte into Rovara Code", () => {
    const text = readFileSync(new URL("../../packages/contracts/src/code-contract-v0.ts", import.meta.url), "utf8");
    expect(/^\s*(import\s|export\s.*\sfrom\s)/mu.test(text)).toBe(false);
    expect(text).not.toMatch(/require\(|process\.|node:/u);
  });
});
