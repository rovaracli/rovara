// Convergence A6 (`cloud/people`): Cloud's IdentityProvider under Code's identity conformance suite, over the in-memory DynamoDB fake (no AWS). The credential is a real browser review session row and the linked
// account a verified Slack sign-in link, read by the same functions Cloud's routes use.
import { createCloudIdentityProvider, BROWSER_SESSION_SCHEME, SLACK_ACCOUNT_PROVIDER } from "../../../packages/broker/src/cloud/adapters/people/index.js";
import { PEOPLE_ORG, SLACK_TEAM, createPeopleWorld } from "../../support/cloud-people-world.js";
import { defineCloudAdapter } from "../registry.js";

const world = createPeopleWorld();
world.linkSlack(world.people.member);
world.signedInAgo(world.people.member, 3_600_000);
const member = world.people.member;

export const cloudIdentity = defineCloudAdapter({
  port: "identity",
  name: "Cloud (Cognito, company SSO, Slack link, members)",
  harness: {
    create: async () => createCloudIdentityProvider(world.routes),
    valid: { credential: { scheme: BROWSER_SESSION_SCHEME, value: member.sessionId }, principal: { companyId: PEOPLE_ORG, personId: member.developerId } },
    linkedAccount: { provider: SLACK_ACCOUNT_PROVIDER, tenant: SLACK_TEAM, accountId: member.slackUserId! },
  },
});
