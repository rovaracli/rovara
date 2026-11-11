// UX2 slice 2 item 5: the broker's wiring for task notifications (`notifications/attention.ts`), run by the five-minute session sweep. The email sender is the install's existing sign-in notice
// sender (`githubConnectedNotice`: DEVELOPER_NOTICE_EMAIL_FROM, the same SES identity and the same ses:SendEmail grant as the identity notices); absent, no email is sent. Each recipient's read
// access is the live session access check, with their org role read from their member record now.
import { OrgRoleSchema, orgMemberKey } from "@agentx/cloud-contracts";
import { type AgentSessionRecord, type OrgId } from "@rovara-code/contracts";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { DeveloperSignInStore } from "../../developer/store.js";
import { sessionAccessFor } from "../../agent-sessions/access.js";
import type { ProjectMembers } from "../../org/project-members.js";
import type { AttentionDeliveryDependencies } from "../../notifications/attention.js";
import type { AwsBrokerDependencies } from "./definitions.js";

export function attentionDeliveryOf(dependencies: AwsBrokerDependencies, projectMembers: Pick<ProjectMembers, "roleOf"> | undefined): AttentionDeliveryDependencies | undefined {
  const developer = dependencies.developer;
  if (developer === undefined || projectMembers === undefined) return undefined;
  const table = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  const signIn = new DeveloperSignInStore({ documentClient: dependencies.documentClient, tableName: developer.signInTableName, nameTableName: dependencies.tableName, now: Date.now });
  const notice = dependencies.githubConnectedNotice;
  return {
    ...table, now: Date.now, // Review M7: the issuer's origin, the same base every other task link uses (`sessionLink`, the session view's `link`, the Slack links). ROVARA_WEB_ORIGIN (set on Cloud for invite links) is not used, so a
    // notification's link is never on a different host than the task page the app itself links to.
    origin: new URL(developer.issuer).origin,
    person: async (developerId) => { const record = await signIn.getDeveloper(developerId);return record === undefined || record.revoked ? undefined : { email: record.email, slackUserId: record.slackUserId }; },
    access: async (orgId: OrgId, developerId: string, session: AgentSessionRecord) => {
      const member = (await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: orgMemberKey(orgId, developerId), ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
      const role = OrgRoleSchema.safeParse(member?.["role"]);
      if (!role.success) return undefined;
      const { access } = await sessionAccessFor({ ...table, now: Date.now, projectMembers }, { orgId, developerId }, role.data, session);
      return access === undefined || access.level === "none" ? undefined : { owner: access.owner };
    },
    ...(notice?.ses === undefined || notice.from === undefined || notice.from === "" ? {} : { email: { ses: notice.ses, from: notice.from } }),
  };
}
