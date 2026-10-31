// Org-tagged secrets (Plan 3, ruling R62). A connection's key or token and an event hook's secret are Secrets Manager
// secrets named `agentx/<env>/org-connectors/<orgId>/<connectionId>` and `agentx/<env>/org-hooks/<orgId>/<hookId>`,
// tagged `rovara:org=<orgId>`. The broker's own role has no Secrets Manager permission on those paths: every call goes
// through a ConnectorSecretsRole session that AssumeRole tagged with the org, and the role's policy lets that session
// reach only its own org's secrets. This class checks the org id and the secret name before any AWS call, so a
// key-building mistake is refused here as well as by IAM. A value is never logged and never put in an error.
import { CreateSecretCommand, DeleteSecretCommand, DescribeSecretCommand, GetSecretValueCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { AssumeRoleCommand, type AssumeRoleCommandOutput } from "@aws-sdk/client-sts";
import { OrgIdSchema, agentXError, type OrgId } from "@agentx/contracts";

export const ORG_TAG_KEY = "rovara:org";
const SESSION_SECONDS = 900;
const REFRESH_MARGIN_MS = 60_000;
const DEFAULT_RECOVERY_DAYS = 7;
/** What a save is told when its secret is waiting to be deleted: not a failure to retry, since only finishing the removal (and adding a new connection) gets past it. */
export const BEING_REMOVED_MESSAGE = "this connection is being removed; remove it again, then add a new one";
/** One path segment: the connection or hook id. No slash, no dot, so a name can never climb out of its org's path. */
const LEAF = /^[A-Za-z0-9_-]{1,128}$/;

export function orgConnectorSecretName(env: string, orgId: string, connectionId: string): string {
  return `agentx/${env}/org-connectors/${orgId}/${connectionId}`;
}

/** A registered MCP server's own token: under the connector path, so the one org-tagged role that reaches an org's connection secrets reaches it and nothing else does. */
export function orgMcpServerSecretName(env: string, orgId: string, serverId: string): string {
  return `agentx/${env}/org-connectors/${orgId}/${serverId}`;
}

export function orgHookSecretName(env: string, orgId: string, hookId: string): string {
  return `agentx/${env}/org-hooks/${orgId}/${hookId}`;
}

/** Whether `leaf` can be the last segment of an org secret name. */
export function isSecretLeaf(leaf: string): boolean {
  return LEAF.test(leaf);
}

export interface AssumedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

export type SecretsCommand = GetSecretValueCommand | PutSecretValueCommand | CreateSecretCommand | DeleteSecretCommand | DescribeSecretCommand;

/** The Secrets Manager calls the broker makes with a session: nothing else, in particular never TagResource or UntagResource. */
export interface SecretsClient {
  send(command: SecretsCommand): Promise<{ SecretString?: string; ARN?: string; VersionId?: string; DeletedDate?: Date }>;
}

export interface StsClient {
  send(command: AssumeRoleCommand): Promise<Pick<AssumeRoleCommandOutput, "Credentials">>;
}

export interface OrgSecretsInput {
  /** The install's environment name, which prefixes every secret name. */
  env: string;
  /** The ConnectorSecretsRole's ARN. */
  roleArn: string;
  sts: StsClient;
  /** A Secrets Manager client that signs with these session credentials. */
  secretsFor(credentials: AssumedCredentials): SecretsClient;
  now?: () => number;
}

interface Session {
  client: SecretsClient;
  expiresAt: number;
}

const errorName = (error: unknown): string | undefined => (error instanceof Error ? error.name : undefined);

export class OrgSecrets {
  private readonly now: () => number;
  /** One session (or one pending AssumeRole) per org. */
  private readonly sessions = new Map<OrgId, Promise<Session>>();

  constructor(private readonly input: OrgSecretsInput) {
    this.now = input.now ?? Date.now;
  }

  /**
   * The secret's value, or undefined when Secrets Manager cannot find it. With `versionId` it reads exactly that version, which stays
   * readable after a newer one is current: a connection reads the version its own save wrote, never one a refused save wrote later.
   */
  async read(orgId: string, name: string, versionId?: string): Promise<string | undefined> {
    const org = this.admit(orgId, name);
    try {
      const response = await this.run(org, (client) => client.send(new GetSecretValueCommand({ SecretId: name, ...(versionId === undefined ? {} : { VersionId: versionId }) })));
      return response.SecretString;
    } catch (error) {
      if (errorName(error) === "ResourceNotFoundException") return undefined;
      throw this.refusal(error);
    }
  }

  /**
   * Creates the secret with the tag `rovara:org=<orgId>` (Secrets Manager also authorizes that as TagResource), or when it
   * exists stores a new version. It never calls TagResource or UntagResource itself. It returns the id of the version it wrote, which the
   * caller records and later reads by (`read` with `versionId`), so what is used is what its own save wrote and nothing a concurrent save wrote.
   */
  async put(orgId: string, name: string, value: string): Promise<string> {
    const org = this.admit(orgId, name);
    try {
      let response: { VersionId?: string };
      try {
        response = await this.run(org, (client) => client.send(new CreateSecretCommand({ Name: name, SecretString: value, Tags: [{ Key: ORG_TAG_KEY, Value: org }] })));
      } catch (error) {
        if (errorName(error) !== "ResourceExistsException") throw error;
        response = await this.run(org, (client) => client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value })));
      }
      if (response.VersionId === undefined || response.VersionId === "") throw agentXError("RUNTIME_UNAVAILABLE", "the connector secret store did not say which version it saved");
      return response.VersionId;
    } catch (error) {
      // A secret scheduled for deletion refuses a new version, and a new secret under its name, as invalid. Waiting does not help (the window is days), so this
      // is not a retryable failure: the connection's removal began and did not finish, and removing it again finishes it. Believed only when the secret says it is scheduled.
      if (errorName(error) === "InvalidRequestException" && await this.isScheduledForDeletion(org, name, false)) throw agentXError("CONFIG_INVALID", BEING_REMOVED_MESSAGE);
      throw this.refusal(error);
    }
  }

  /** Schedules the secret for deletion after a recovery window (7 to 30 days). A secret Secrets Manager cannot find is already gone. */
  async scheduleDelete(orgId: string, name: string, recoveryDays: number = DEFAULT_RECOVERY_DAYS): Promise<void> {
    const org = this.admit(orgId, name);
    try {
      await this.run(org, (client) => client.send(new DeleteSecretCommand({ SecretId: name, RecoveryWindowInDays: recoveryDays })));
    } catch (error) {
      if (errorName(error) === "ResourceNotFoundException") return;
      // A secret already scheduled for deletion refuses a second delete as invalid, but the exception has other causes, so it is believed only
      // when the secret itself says it is scheduled (DeletedDate): a repeat of a removal, or a closed org run again, is then done. Anything else fails closed.
      if (errorName(error) === "InvalidRequestException" && await this.isScheduledForDeletion(org, name, true)) return;
      throw this.refusal(error);
    }
  }

  /** Whether Secrets Manager says the secret is scheduled for deletion. `goneCounts`: a secret it cannot find at all is as good as scheduled (true for a delete, not for a write). */
  private async isScheduledForDeletion(org: OrgId, name: string, goneCounts: boolean): Promise<boolean> {
    try {
      const described = await this.run(org, (client) => client.send(new DescribeSecretCommand({ SecretId: name })));
      return described.DeletedDate !== undefined;
    } catch (error) {
      // A failure to ask is no answer, and the call's own refusal stands.
      return goneCounts && errorName(error) === "ResourceNotFoundException";
    }
  }

  /** The org id and the name, checked against each other before anything is sent to AWS. */
  private admit(orgId: string, name: string): OrgId {
    const parsed = OrgIdSchema.safeParse(orgId);
    if (!parsed.success) throw agentXError("FORBIDDEN", "that is not an organization id");
    const org = parsed.data;
    const { env } = this.input;
    for (const prefix of [`agentx/${env}/org-connectors/${org}/`, `agentx/${env}/org-hooks/${org}/`]) {
      if (name.startsWith(prefix) && LEAF.test(name.slice(prefix.length))) return org;
    }
    throw agentXError("FORBIDDEN", "that secret does not belong to this organization");
  }

  /** Runs one call on the org's session; a session AWS reports as expired is replaced once. */
  private async run<T>(org: OrgId, call: (client: SecretsClient) => Promise<T>): Promise<T> {
    const session = await this.session(org);
    try {
      return await call(session.client);
    } catch (error) {
      if (errorName(error) !== "ExpiredTokenException" && errorName(error) !== "ExpiredToken") throw error;
      this.sessions.delete(org);
      return call((await this.session(org)).client);
    }
  }

  private session(org: OrgId): Promise<Session> {
    const cached = this.sessions.get(org);
    if (cached !== undefined) {
      return cached.then((session) => {
        if (session.expiresAt - REFRESH_MARGIN_MS > this.now()) return session;
        // Replace only the session we looked at: another caller may have replaced it already.
        if (this.sessions.get(org) === cached) this.sessions.delete(org);
        return this.session(org);
      });
    }
    const created = this.assume(org);
    this.sessions.set(org, created);
    created.catch(() => { if (this.sessions.get(org) === created) this.sessions.delete(org); });
    return created;
  }

  private async assume(org: OrgId): Promise<Session> {
    const response = await this.input.sts.send(new AssumeRoleCommand({
      RoleArn: this.input.roleArn,
      // The org id is in the name so CloudTrail shows which org a session served (AWS allows [\w+=,.@-], 2 to 64 characters).
      RoleSessionName: `org-${org}`,
      DurationSeconds: SESSION_SECONDS,
      Tags: [{ Key: ORG_TAG_KEY, Value: org }],
    }));
    const credentials = response.Credentials;
    if (credentials?.AccessKeyId === undefined || credentials.SecretAccessKey === undefined || credentials.SessionToken === undefined || credentials.Expiration === undefined) {
      throw agentXError("RUNTIME_UNAVAILABLE", "the connector secrets role gave no credentials");
    }
    const expiration = credentials.Expiration;
    return {
      client: this.input.secretsFor({ accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken, expiration }),
      expiresAt: expiration.getTime(),
    };
  }

  /** An AWS failure as a coded error that names its class and nothing else: an SDK message could quote request content. */
  private refusal(error: unknown): Error {
    if (error instanceof Error && error.name === "AgentXError") return error;
    const name = errorName(error) ?? "unknown";
    if (name === "AccessDeniedException" || name === "AccessDenied") return agentXError("FORBIDDEN", "the connector secrets role refused the request");
    return agentXError("RUNTIME_UNAVAILABLE", `the connector secret store failed (${name})`);
  }
}
