// Convergence A6 (`cloud/people`): Cloud's Approvers under Code's approvers conformance suite, over the in-memory DynamoDB fake (no AWS). The acceptable proof is a low-risk coding plan approved in a signed-in browser
// (a real review session row); the issuers are the production ones (`cloudApprovalIssuers`).
import { randomUUID } from "node:crypto";
import { BROWSER_SESSION_METHOD, cloudApprovalIssuers, createCloudApprovers } from "../../../packages/broker/src/cloud/adapters/people/index.js";
import { PEOPLE_ORG, createPeopleWorld } from "../../support/cloud-people-world.js";
import { defineCloudAdapter } from "../registry.js";

const world = createPeopleWorld();
const member = world.people.member;
const request = { companyId: PEOPLE_ORG, requestId: "req-a6-conformance", kind: "plan", subject: { type: "task", id: randomUUID() }, revision: 3, artifactDigest: "a".repeat(64), risk: "low" as const };

export const cloudApprovers = defineCloudAdapter({
  port: "approvers",
  name: "Cloud (approval place, step-up, second person)",
  harness: {
    create: async () => createCloudApprovers({
      issuers: cloudApprovalIssuers({ routes: world.routes, slackLookups: world.slackLookups }),
      deciderRole: async () => "owner",
      place: { documentClient: world.db, tableName: "state", signInTableName: "signin", now: world.now },
    }),
    request,
    acceptable: { proofId: "p", method: BROWSER_SESSION_METHOD, requestId: request.requestId, revision: request.revision, artifactDigest: request.artifactDigest, token: member.sessionId },
    forgedToken: randomUUID(),
  },
});
