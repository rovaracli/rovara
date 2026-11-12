// Cloud drivers: Spend limits, approvals, erasure, multi-project companies (areas 22, 23, 25, 39).
//
// Spend: the journey harness wires no model proxy (createWorkflowE2E has no `modelAccess` option), so Cloud's own start admission
// (`thread-workspaces.ts#admitSlackWork`, `developer-tasks/start.ts` -> `admitWork`) is skipped there and a budget can never refuse a journey start. The
// `feature:spend.start-*` driver therefore asks Cloud's REAL `admitWork` for the start (the same function, over the same table rows the harness holds, with a fake
// model proxy at the seeded figures) and starts the task through the journey only when Cloud admits it. Shared change that would remove this: a `modelAccess`
// option on createWorkflowE2E passed to the broker it builds.
import { randomUUID } from "node:crypto";
import { AgentXError, ROVARA_CODE_AGENT_ID, projectMemberKey, singleOrgIdForEnv } from "@rovara-code/contracts";
import { admitWork } from "../../../../packages/broker/src/spend/admission.js";
import type { SpendPath } from "../../../../packages/broker/src/org/budget.js";
import { fakeModelAccess } from "../../../support/fake-model-access.js";
import { TEST_ENV } from "../../../support/orgs.js";
import { call } from "../../../support/slack-broker.js";
import { E2E_CHECK, SLACK_MAYA } from "../../../support/workflow-e2e.js";
import { asMaya } from "./task-flow.js";
import type { CloudContext, CloudOptions } from "../cloud-context.js";
import type { StepDriver } from "../drivers.js";
import { cloudSpendItems, monthNow, spendStepOf } from "../people-money-support/spend.js";

type Driver = StepDriver<CloudContext, CloudOptions>;

const ORG = singleOrgIdForEnv(TEST_ENV);

/** Asks Cloud's start admission about a start on `path`, records the outcome in the spend facet, and starts the task when admitted. */
const spendStart = (path: SpendPath): Driver => ({
  async run(ctx) {
    const seeded = spendStepOf(ctx.scenario);
    const access = fakeModelAccess();
    const limitUsd = seeded?.usd;
    const spentUsd = seeded?.spentUsd ?? 0;
    // The proxy knows the org at the seeded limit and spend (admitWork syncs it first; the spend set after a sync stays).
    if (limitUsd !== undefined) { await access.upsertOrg(ORG, limitUsd); access.setOrgSpent(ORG, spentUsd); }
    try {
      await admitWork({ documentClient: ctx.e2e.db, tableName: "state", access, now: () => Date.now(), cloud: false }, {
        orgId: ORG, payer: { kind: "member", developerId: SLACK_MAYA.developerId }, project: "payments", agentId: ROVARA_CODE_AGENT_ID, agentName: "Rovara Code", path,
      });
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      // The admission word in the core's vocabulary (A5's refusal codes are Cloud's error codes in lower case), the code the person's surface gets, and the words they read.
      ctx.extra.spend.push(`refused:task.start:${error.code.toLowerCase()}`, `start_refused:${error.code}`, `refusal_message:${error.message.replace(`${error.code}: `, "")}`);
      if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "cloud.spend", words: ctx.extra.spend, message: error.message }));
      return;
    }
    ctx.extra.spend.push("admitted:task.start");
    if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "cloud.spend", words: ctx.extra.spend }));
    if (await ctx.e2e.mention(`${path === "FULL" ? "full" : "quick"}: Add a greet(name) function`) !== 200) throw new Error("Cloud refused the mention");
    await ctx.e2e.settle();
  },
});

/** The second project of the company: the same repository, its own name (registered as Cloud's admin registers one). */
const BILLING = {
  definition: { name: "billing", revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [E2E_CHECK], orchestratorInstructions: "Delegate work." },
  runtimeBinding: { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" as const },
};

/** A start through Cloud's developer route (the same surface as the core's `/v1/dev/tasks`), as Maya; a refusal is recorded and ends nothing else. */
const startApi = (project: string): Driver => ({
  async run(ctx) {
    const started = await asMaya(ctx, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project, instructions: "Add a greet(name) function", workflow: true, workflowPath: "QUICK" });
    if (started.statusCode >= 300) {
      const refusal = (JSON.parse(started.body) as { error?: { code?: string } }).error;
      ctx.extra.spend.push(`start_refused:${String(refusal?.code)}`);
      if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "cloud.startApi", project, refused: ctx.extra.spend.at(-1) }));
      return;
    }
    await ctx.e2e.settle();
  },
});

export const PEOPLE_MONEY_DRIVERS: Record<string, Driver> = {
  "spend.limit": {
    async run(ctx, step) {
      const seeded = step as ReturnType<typeof spendStepOf> & object;
      for (const item of cloudSpendItems(ORG, monthNow(new Date()), seeded.usd, seeded.spentUsd ?? 0)) ctx.e2e.db.set(item);
    },
  },
  "feature:spend.start-quick": spendStart("QUICK"),
  "feature:spend.start-full": spendStart("FULL"),
  "project.second": {
    // One workspace per person (Cloud's SLACK_MEMBER_WORKSPACE_LIMIT, the stack's per-person limit), so a second open task of the same person is refused wherever it starts.
    options: () => ({ memberLimit: 1 }),
    async run(ctx) {
      const registered = await call(ctx.e2e.handler, { method: "POST", path: "/v1/admin/projects", user: { subject: "admin-subject", admin: true }, body: BILLING });
      if (registered.status !== 201) throw new Error(`Cloud refused the second project: ${JSON.stringify(registered.body).slice(0, 200)}`);
      // Maya contributes to both projects (Cloud holds project membership per project; the core's local owner may use every project).
      for (const project of ["payments", "billing"]) {
        ctx.e2e.db.set({ ...projectMemberKey(ORG, SLACK_MAYA.developerId, project), entityType: "MEMBERSHIP", ownerKey: SLACK_MAYA.developerId, projectName: project, grantId: randomUUID(), role: "developer", projectRole: "contributor" });
      }
    },
  },
  "feature:start-api:payments": startApi("payments"),
  "feature:start-api:billing": startApi("billing"),
  // Drivable on Cloud's path (a teammate or a second person pressing Approve in Slack; the person erase walk, rovara-code/evidence-erase.ts), but the core
  // engine cannot drive either step (core-drivers/people-money.ts says why in full), so the Cloud half is not written yet: it would never be compared.
  "approval.needed": {
    supports: () => ({ unsupported: "not compared until the core engine can present a second person: its local composition has one owner and A6's approvers are not registrable there (core-drivers/people-money.ts)" }),
    run: () => Promise.reject(new Error("unsupported")),
  },
  "person.erase": {
    supports: () => ({ unsupported: "not compared: Code's core has no person erasure (decision 41; its per-workspace erase needs an S0 adapter that is not written, core-drivers/people-money.ts)" }),
    run: () => Promise.reject(new Error("unsupported")),
  },
};
