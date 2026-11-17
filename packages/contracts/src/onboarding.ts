import { AgentXNameSchema } from "./names.js";
import { forwardReader } from "./forward-reader.js";
import { z } from "zod";
import { cleanDisplayName } from "./display-name.js";
export const RenameOrganizationBodySchema = z.object({
 requestId: z.string().uuid(),
 name: z.string().refine(value => Array.from(value).length <= 80, "must have at most 80 characters").transform(value => cleanDisplayName(value)).refine((value): value is string => value !== undefined, "must have a printable name"),
}).strict();
export const RenameOrganizationResponseSchema = z.object({ org: z.object({ orgId: z.string(), name: z.string(), plan: z.string() }), role: z.literal("owner") });

const COMMAND_MAX_LENGTH = 500;
const DESCRIPTION_MAX_LENGTH = 280;
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
/** Commands a project is created with: one in `setupCommand`/`testCommand`, or the whole ordered list in `setupCommands`/`testCommands` (the same 16 that project settings keep). */
const COMMANDS_MAX = 16;
const commandList = z.array(z.string().max(COMMAND_MAX_LENGTH)).min(1).max(COMMANDS_MAX);
export const CreateProjectBodySchema = z.object({
  requestId: z.string().uuid(),
  repository: z.string().regex(REPOSITORY, "must be owner/name").refine((value) => !/\/(\.{1,2}|\.git)$/.test(value), "must be owner/name"),
  name: AgentXNameSchema.optional(),
  description: z.string().max(DESCRIPTION_MAX_LENGTH).optional(),
  setupCommand: z.string().max(COMMAND_MAX_LENGTH).optional(),
  testCommand: z.string().max(COMMAND_MAX_LENGTH).optional(),
  setupCommands: commandList.optional(),
  testCommands: commandList.optional(),
}).strict().superRefine((body, context) => {
  for (const [single, list] of [["setupCommand", "setupCommands"], ["testCommand", "testCommands"]] as const) {
    if (body[single] !== undefined && body[list] !== undefined) context.addIssue({ code: "custom", path: [list], message: `give ${single} or ${list}, not both` });
  }
});
export const CreateOrganizationInviteBodySchema = z.object({ requestId: z.string().uuid(), role: z.enum(["admin", "member"]), email: z.string().trim().email().max(254).optional() }).strict();
export const OrganizationInviteResponseSchema = z.object({ inviteUrl: z.string() });
/**
 * The token an invite link carries (`/app/join#invite=<token>`, DEC 254h): Rovara Code's single-use invite secret (URL-safe, at least 128 bits,
 * with Code's fixed prefix), or, from a Code that mints none, Cloud's own 43-character token. One pattern for the server, the app and the link check.
 */
export const INVITE_LINK_TOKEN = /^[A-Za-z0-9_-]{22,128}$/u;
export const GithubConnectResponseSchema = z.object({ installUrl: z.string(), authorizeUrl: z.string().optional(), expiresAt: z.string(), orgName: z.string().optional(), ownerName: z.string().optional() });
/** Guided onboarding PR 2: the GitHub callback's outcome, kept server-side for this sign-in (POST /v1/app/github/connect/result) or a choice's answer (POST /v1/app/github/choose). Never a ticket. */
const GithubLoginSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);
const GithubConnectedSchema = z.object({ status: z.literal("connected"), alreadyConnected: z.boolean(), accountLogin: GithubLoginSchema, accountType: z.enum(["User", "Organization"]), trialUsed: z.literal(true).optional() });
export const GithubConnectResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none") }),
  GithubConnectedSchema,
  z.object({ status: z.literal("choose"), githubLogin: GithubLoginSchema, installations: z.array(z.object({ installationId: z.number().int().positive(), accountLogin: GithubLoginSchema, accountType: z.enum(["User", "Organization"]), suspended: z.boolean(), connection: z.enum(["this_company", "another_company", "unbound"]) })).max(100) }),
  z.object({ status: z.literal("requested"), adminUrl: z.string().optional() }),
]);
export const GithubChooseBodySchema = z.object({ installationId: z.number().int().positive() }).strict();
export const GithubChooseResponseSchema = GithubConnectedSchema;
/** The company's connected GitHub accounts (GET /v1/app/github/connections, Code's GET /v1/dev/company/github; any member). */
export const GithubConnectionsResponseSchema = z.object({ installations: z.array(z.object({ installationId: z.number().int().positive(), accountLogin: z.string(), connectedAt: z.string(), connectedBy: z.union([z.object({ kind: z.literal("person"), name: z.string().optional() }), z.object({ kind: z.literal("operator") })]) })) });
/** Guided onboarding PR 11: Add to Slack, a project's Slack channel, Connect Linear and a project's Linear team (Cloud's server answers; names and flags only). */
const ConnectStartSchema = z.object({ authorizeUrl: z.string(), expiresAt: z.string() });
export const ConnectStartBodySchema = z.object({ back: z.string().regex(/^\/app(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,99}){0,4}$/).optional() }).strict();
export const SlackInstallStartResponseSchema = ConnectStartSchema;
export const SlackInstallResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none") }),
  z.object({ status: z.literal("connected"), alreadyConnected: z.boolean(), workspaceName: z.string().optional(), mismatch: z.object({ signedInName: z.string().optional() }).optional() }),
]);
export const SlackWorkspaceResponseSchema = z.object({ workspace: z.object({ teamName: z.string().optional(), state: z.enum(["connected", "disconnected"]), connectedAt: z.string(), connectedBy: z.object({ kind: z.enum(["person", "operator"]), name: z.string().optional() }) }).nullable() });
export const SlackDisconnectResponseSchema = z.object({ status: z.literal("disconnected"), workspaceName: z.string().optional(), projectsLosingChannel: z.array(z.string()) });
const SlackChannelSchema = z.object({ id: z.string(), name: z.string(), isPrivate: z.boolean() });
export const SlackChannelsResponseSchema = z.object({ channels: z.array(SlackChannelSchema.extend({ linked: z.literal(true).optional(), linkedProject: z.string().optional() })), nextCursor: z.string().optional() });
export const SlackProjectChannelResponseSchema = z.object({ connected: z.boolean(), channels: z.array(z.object({ id: z.string() })) });
export const SlackLinkBodySchema = z.object({ channelId: z.string().regex(/^[CG][A-Z0-9]{2,31}$/) }).strict();
export const SlackLinkResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("linked"), channel: SlackChannelSchema, alreadyLinked: z.boolean(), replaced: z.array(z.string()) }),
  z.object({ status: z.literal("invite_needed"), channel: z.object({ id: z.string() }), message: z.string() }),
]);
export const SlackUnlinkResponseSchema = z.object({ status: z.literal("unlinked"), channels: z.array(z.string()) });
export const LinearConnectStartResponseSchema = ConnectStartSchema;
export const LinearConnectResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none") }),
  z.object({ status: z.literal("connected"), reconnected: z.boolean(), workspaceName: z.string(), urlKey: z.string() }),
]);
export const LinearStatusResponseSchema = z.object({ status: z.enum(["connected", "needs_reconnect", "disconnected"]), workspace: z.object({ name: z.string(), urlKey: z.string() }).optional(), connectedAt: z.string().optional(), connectedBy: z.object({ name: z.string().optional() }).optional() });
export const LinearDisconnectResponseSchema = z.object({ status: z.literal("disconnected"), workspaceName: z.string(), projects: z.array(z.string()) });
const LinearTeamSchema = z.object({ id: z.string(), key: z.string(), name: z.string() });
export const LinearProjectTeamResponseSchema = z.object({ team: LinearTeamSchema.nullable(), teams: z.array(LinearTeamSchema) });
export const LinearPickBodySchema = z.object({ teamId: z.string().regex(/^[A-Za-z0-9-]{1,100}$/) }).strict();
export const LinearPickResponseSchema = z.object({ team: LinearTeamSchema });
export const LinearClearResponseSchema = z.object({ team: z.null(), cleared: z.boolean() });
export const GithubInstallationsResponseSchema = z.object({ installations: z.array(z.object({ installationId: z.number().int().positive(), accountLogin: z.string(), accountType: z.enum(["User", "Organization"]), repositorySelection: z.enum(["all", "selected"]), status: z.enum(["active", "suspended", "removed"]) })) });
export const GithubRepositoriesResponseSchema = z.object({ repositories: z.array(z.object({ fullName: z.string(), githubRepositoryId: z.number().int().positive(), private: z.boolean(), defaultBranch: z.string(), project: z.string().optional() })) });
export const CloudProjectCreatedResponseSchema = z.object({ duplicate: z.boolean(), project: z.object({ definition: z.object({ name: AgentXNameSchema }), registeredAt: z.string() }), warnings: z.array(z.string()).optional() });
export const ProjectRosterAddedResponseSchema = z.object({ agent: z.object({ agentId: z.string(), name: z.string().optional() }) });
export const GithubConnectResponseReaderSchema = forwardReader(GithubConnectResponseSchema);
export const GithubInstallationsResponseReaderSchema = forwardReader(GithubInstallationsResponseSchema);
export const GithubConnectResultReaderSchema = forwardReader(GithubConnectResultSchema);
export const GithubChooseResponseReaderSchema = forwardReader(GithubChooseResponseSchema);
export const GithubConnectionsResponseReaderSchema = forwardReader(GithubConnectionsResponseSchema);
export const SlackInstallStartResponseReaderSchema = forwardReader(SlackInstallStartResponseSchema);
export const SlackInstallResultReaderSchema = forwardReader(SlackInstallResultSchema);
export const SlackWorkspaceResponseReaderSchema = forwardReader(SlackWorkspaceResponseSchema);
export const SlackDisconnectResponseReaderSchema = forwardReader(SlackDisconnectResponseSchema);
export const SlackChannelsResponseReaderSchema = forwardReader(SlackChannelsResponseSchema);
export const SlackProjectChannelResponseReaderSchema = forwardReader(SlackProjectChannelResponseSchema);
export const SlackLinkResponseReaderSchema = forwardReader(SlackLinkResponseSchema);
export const SlackUnlinkResponseReaderSchema = forwardReader(SlackUnlinkResponseSchema);
export const LinearConnectStartResponseReaderSchema = forwardReader(LinearConnectStartResponseSchema);
export const LinearConnectResultReaderSchema = forwardReader(LinearConnectResultSchema);
export const LinearStatusResponseReaderSchema = forwardReader(LinearStatusResponseSchema);
export const LinearDisconnectResponseReaderSchema = forwardReader(LinearDisconnectResponseSchema);
export const LinearProjectTeamResponseReaderSchema = forwardReader(LinearProjectTeamResponseSchema);
export const LinearPickResponseReaderSchema = forwardReader(LinearPickResponseSchema);
export const LinearClearResponseReaderSchema = forwardReader(LinearClearResponseSchema);
export const GithubRepositoriesResponseReaderSchema = forwardReader(GithubRepositoriesResponseSchema);
export const CloudProjectCreatedResponseReaderSchema = forwardReader(CloudProjectCreatedResponseSchema);

export const RevokeOrganizationInviteBodySchema = z.object({ requestId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() }).strict();
export const RevokeOrganizationInviteResponseSchema = z.object({ inviteId: z.string().uuid(), revokedAt: z.string().datetime(), revision: z.number().int().positive() }).strict();
