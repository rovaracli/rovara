// Contract v0 between Rovara Cloud's web app and Rovara Code (packages/contracts/src/code-contract-v0.ts): the tables are consistent, and the
// file stays free of imports so the same bytes can sit in both repositories.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_ROUTES, CODE_ROUTES, contractCounts, matchCodeRoute, pathParamNames, pathPattern } from "../../packages/contracts/src/code-contract-v0.js";
import { DEFAULT_TICKET_UPDATES, NEW_HOSTED_TICKET_UPDATES, TICKET_UPDATE_LEVELS, TICKET_UPDATE_LEVEL_WORDS, TicketStatusNameSchema } from "../../packages/contracts/src/ticket-updates.js";

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

  it("has no repository lessons file route (Rovara keeps what it learns inside Rovara; owner decision 2026-11-17)", () => {
    expect(APP_ROUTES.filter((route) => /\/lessons\/repo(?:\/|$)/u.test(route.path) || route.source === "lessons-repo-file").map((route) => `${route.method} ${route.path}`)).toEqual([]);
    expect(CODE_ROUTES.filter((route) => /lessons\/repo(?:\/|$)/u.test(route.path)).map((route) => `${route.method} ${route.path}`)).toEqual([]);
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
    // Plus the project wiki's page list, search, one page and its cited files (lead 4 W5).
    // Plus the project machine-size read and stored-choice write (machine-size screen).
    // Plus the wiki's corrections: the notes, marks, approvals and the disputed list (lead 4 C1): 8 rows.
    // Plus the setup approval (L4-D2): confirm flips to answered here, discard and decide are added: 3.
    // Plus the wiki panel on the setup page: the file map, the build controls and the nightly upkeep switch (lead 4 W6): 11 rows.
    // Plus the Cost and time report (Feature A, slice A3): the report and a feature's page: 2 rows.
    // Plus How we work (walkthrough 2026-11-17 item 4): forwarded to Code's own GET /v1/app/projects/{p}/how-we-work as the person (an existing row, L to LT: +1).
    // Plus the smart Just answer's ask and the start box's suggestion, both off unless the deployment's answers setting is on (lead 4 J3), and "Not right" on an answer (lead 4 J5).
    // Plus the Cost and time actions (lane L4-CR4): a new feature, rename, merge, mark done or reopen, and move a task, each passed to Code's own route as the person (Code decides): 5 rows.
    // Plus the session's decisions and answers (L4-B5, Code's task log read as the person): 1 row.
    // Plus script-token list, create and revoke, mirrored from Code's app routes: 3 rows.
    // (The person's own sign-in factors row, L4-MF4, is gone: owner DEC 254zzz73 removed step-up and its confirmation email and passkeys: -1 row.)
    // Plus the saved environment panel read (forwarded to Code's own route) and the start preview (answered here as unknown) (L4-MF1): existing rows, now T (the start preview's owner is now Cloud: c): 2.
    // Plus the company's one control over nightly upkeep (L4-P3): read and change: 2 rows.
    // Plus lessons phase 4 (L4-LP4G): the graduation read, graduate, Not now, both places, the two tidy writes, the two draft task writes and retiring a team rule: 9 rows.
    // Plus the person's own GitHub account link (L4-GH): read, connect and unlink, passed to Code's /v1/dev/me/github routes as the person: 3 rows.
    // Plus the project lessons measure (L4-MEAS): 1 row.
    // Plus the plan card's feature choices (lead 4 PCF): Code answers this read as the person.
    // Plus the "Setup needs repair" card and its "Re-check setup" button (L4-U5): read and recheck: 2 rows.

    // Plus the setup checklist's "Eval check from your CI" (L4-EVCI2): the read and the confirm, passed to Code's own routes as the person: 2 rows.
    // Plus the lessons by code area, "Where Rovara learns from" with its pause, and the wiki page's team lessons (lead 4 L4-LP3W): 4 rows.
    // Plus the setup flow's eval card (L4-EVC): the read and the one approval, each passed to Code's own route as the person: 2 rows.
    // Plus the setup flow's eval card (L4-EVC): the read, the one approval, a decision on a waiting spend item and the opt-in health check, each passed to Code's own route as the person: 4 rows.
    // Plus the person's own "Don't learn from my Slack messages" switch (L4-SRC-SL): read and set, as the person: 2 rows.
    // Plus Rovara's outbound addresses for company owners and admins (L4-EGR): the read, passed to Code as the person: 1 row.
    // Plus Rovara's proposed wrapper file (L4-EVW2): "Try again", passed to Code's own route as the person: 1 row.
    // Plus answering Understand's questions from the Work list and Home (Code #1057's round on the list row): the task's answers, passed to Code as the person: 1 row.
    // Plus the model the company's lessons learn with (DEC 254zzz63, Code #1075): read and change, passed to Code as the person: 2 rows.
    expect(counts.appCloudServerToday).toBe(178);
  });

  it("says no route is served from the laptop core: the seven whose code exists only there arrive with E2, with nothing to cite on the deployed API", () => {
    expect(CODE_ROUTES.every((route) => route.awsApi === "yes" || route.awsApi === "no")).toBe(true);
    const e2 = CODE_ROUTES.filter((route) => route.arrivesWith !== undefined).map((route) => route.id).sort();
    expect(e2).toEqual(["decisions.act", "decisions.list", "howWeWork.get", "playbook.get", "playbook.put", "tasks.answers", "tasks.evidence.get"].sort());
    for (const route of CODE_ROUTES.filter((entry) => entry.arrivesWith !== undefined)) {
      expect(route.awsApi).toBe("no");
      expect(route.mainline).toBe(false);
      expect(route.evidence).toBe("none");
      expect(route.arrivesWith).toMatch(/^E2 \(core on AWS\); laptop core: /u);
    }
    expect(contractCounts().neededArrivesWithE2).toBe(7);
  });

  it("keeps Code's routes under /v1/dev, sign-in under /v1/auth and script tokens on Code's /v1/app routes", () => {
    for (const route of CODE_ROUTES) expect(route.path.startsWith("/v1/dev/") || route.path.startsWith("/v1/auth/") || route.id.startsWith("scriptTokens.") && route.path.startsWith("/v1/app/script-tokens"), route.id).toBe(true);
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

  it("mirrors Code's script-token app routes, full scope and POST revoke", () => {
    for (const [method, path, id] of [
      ["GET", "/v1/app/script-tokens", "scriptTokens.list"],
      ["POST", "/v1/app/script-tokens", "scriptTokens.create"],
      ["POST", "/v1/app/script-tokens/stk_aaaaaaaaaaaaaaaaaaaa/revoke", "scriptTokens.revoke"],
    ] as const) {
      expect(matchCodeRoute(method, path)?.route).toMatchObject({ id, scope: "full", cloudCallsToday: true, awsApi: "yes" });
      expect(APP_ROUTES.find(row => row.codeRoutes.includes(id))?.cloudServerToday).toBe(true);
    }
    expect(matchCodeRoute("DELETE", "/v1/app/script-tokens/stk_aaaaaaaaaaaaaaaaaaaa")).toBeUndefined();
  });

  it("declares the nine lessons phase 4 routes (graduation and tidy) as Code routes Cloud calls and web rows Cloud answers, and Code's tidy retire has its own literal path", () => {
    const rows = [
      ["lessons.graduation", "GET", "/v1/dev/projects/{project}/lessons/graduation", "GET /v1/app/projects/{p}/lessons/graduation"],
      ["lessons.graduate", "POST", "/v1/dev/projects/{project}/lessons/{lessonId}/graduate", "POST /v1/app/projects/{p}/lessons/{lessonId}/graduate"],
      ["lessons.graduateLater", "POST", "/v1/dev/projects/{project}/lessons/{lessonId}/graduate-later", "POST /v1/app/projects/{p}/lessons/{lessonId}/graduate-later"],
      ["lessons.bothPlaces", "POST", "/v1/dev/projects/{project}/lessons/{lessonId}/both-places", "POST /v1/app/projects/{p}/lessons/{lessonId}/both-places"],
      ["lessons.tidy.retire", "POST", "/v1/dev/projects/{project}/lessons/tidy/retire-chosen", "POST /v1/app/projects/{p}/lessons/tidy/retire"],
      ["lessons.tidy.later", "POST", "/v1/dev/projects/{project}/lessons/tidy/later", "POST /v1/app/projects/{p}/lessons/tidy/later"],
      ["lessons.checkDraft.started", "POST", "/v1/dev/projects/{project}/lessons/check-drafts/{draftId}/started", "POST /v1/app/projects/{p}/lessons/check-drafts/{draftId}/started"],
      ["lessons.checkDraft.dismiss", "POST", "/v1/dev/projects/{project}/lessons/check-drafts/{draftId}/dismiss", "POST /v1/app/projects/{p}/lessons/check-drafts/{draftId}/dismiss"],
      ["lessons.rules.retire", "POST", "/v1/dev/projects/{project}/lessons/rules/{ruleId}/retire", "POST /v1/app/projects/{p}/lessons/rules/{ruleId}/retire"],
    ] as const;
    for (const [id, method, path, app] of rows) {
      expect(CODE_ROUTES.find((route) => route.id === id), id).toMatchObject({ method, path, scope: "full", screens: ["how-we-work"], cloudCallsToday: true });
      const row = APP_ROUTES.find((entry) => `${entry.method} ${entry.path}` === app);
      expect(row, app).toMatchObject({ owner: "code", screen: "how-we-work", codeRoutes: [id], cloudServerToday: true });
    }
    expect(matchCodeRoute("POST", "/v1/dev/projects/web/lessons/tidy/retire-chosen")?.route.id).toBe("lessons.tidy.retire");
    // Code's path for the tidy retire is its own literal, so it never collides with a lesson id's retire row.
    expect(matchCodeRoute("POST", "/v1/dev/projects/web/lessons/tidy/retire")?.route.id).toBe("lessons.retire");
    expect(matchCodeRoute("POST", "/v1/dev/projects/web/lessons/les_retry0001/retire")?.route.id).toBe("lessons.retire");
    expect(matchCodeRoute("GET", "/v1/dev/projects/web/lessons/graduation")?.route.id).toBe("lessons.graduation");
    expect(matchCodeRoute("POST", "/v1/dev/projects/web/lessons/rules/rule_0123456789abcdef/retire")?.route.id).toBe("lessons.rules.retire");
    expect(matchCodeRoute("POST", "/v1/dev/projects/web/lessons/check-drafts/chk_0123456789abcdef/started")?.params).toEqual({ project: "web", draftId: "chk_0123456789abcdef" });
  });

  it("has no imports, so it can be copied byte for byte into Rovara Code", () => {
    const text = readFileSync(new URL("../../packages/contracts/src/code-contract-v0.ts", import.meta.url), "utf8");
    expect(/^\s*(import\s|export\s.*\sfrom\s)/mu.test(text)).toBe(false);
    expect(text).not.toMatch(/require\(|process\.|node:/u);
  });

  it("pins ticket update settings to Code contract 5d7b2e934", () => {
    expect(TICKET_UPDATE_LEVELS).toEqual(["status_only", "decisions", "plan_decisions", "full"]);
    expect(NEW_HOSTED_TICKET_UPDATES).toEqual({ comments: true, changeStatus: false, statuses: { started: "In Progress", pr_opened: "In Review", merged: "Done" }, level: "full" });
    expect(DEFAULT_TICKET_UPDATES).toEqual({ comments: true, changeStatus: false, statuses: { started: "In Progress", pr_opened: "In Review", merged: "Done" } });
    expect(Object.keys(TICKET_UPDATE_LEVEL_WORDS)).toEqual(TICKET_UPDATE_LEVELS);
    expect(TicketStatusNameSchema.safeParse("project-1").success).toBe(true);
  });
});
