// Test services TS26 (design test-services.md 6.2): a customer test account's secret, kept in Secrets Manager under `agentx/<env>/org-test-accounts/<org>/<account>`, tagged `rovara:org=<org>` and
// `rovara:use=test-account`. Every call goes through a TestAccountSecretsRole session that AssumeRole tagged with the org AND a purpose (infra/lib/test-account-secrets-policy.ts):
//   - `store`: the broker's own session. It can create a secret, put a new version, and schedule its deletion. The client type below has no GetSecretValue in it, and the role denies the read as well, so the
//     broker NEVER holds a value after writing it, and nothing here returns one;
//   - `resolve`: a session minted for the worker of ONE sealed round and narrowed by a session policy to the one secret and the one read. It is handed over as credentials; this module never uses it.
// The value is never logged and never put in an error: a failure is reported by the class of the AWS error only. The org id and the names are checked against each other before any AWS call, so a key-building
// mistake is refused here as well as by IAM.
import { CreateSecretCommand, DeleteSecretCommand, DescribeSecretCommand, PutSecretValueCommand, UpdateSecretVersionStageCommand } from "@aws-sdk/client-secrets-manager";
import { AssumeRoleCommand, type AssumeRoleCommandOutput } from "@aws-sdk/client-sts";
import {
  OrgIdSchema, TEST_ACCOUNT_GRANT_SECONDS, TEST_ACCOUNT_SECRET_PENDING_STAGE, TEST_ACCOUNT_SECRET_TAG_KEYS, TEST_ACCOUNT_SECRET_USE, TEST_ACCOUNT_SECRET_VERSION_STAGE, TestAccountIdSchema, agentXError, testAccountSecretName, testAccountSecretTags,
  type OrgId,
} from "@agentx/contracts";

const SESSION_SECONDS = 900;
const REFRESH_MARGIN_MS = 60_000;
const DEFAULT_RECOVERY_DAYS = 7;
const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const VALUE_MAX = 4_096;

/** What a secret already scheduled for deletion is told: finishing the removal (and adding a new account) is the way past it. */
export const ACCOUNT_BEING_REMOVED_MESSAGE = "this test account is being removed; remove it again, then add a new one";

export interface SessionCredentials { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date }

/** The Secrets Manager calls the broker's store session makes. GetSecretValue is not among them, on purpose. */
export type StoreCommand = CreateSecretCommand | PutSecretValueCommand | DeleteSecretCommand | DescribeSecretCommand | UpdateSecretVersionStageCommand;
export interface StoreClient {
  send(command: StoreCommand): Promise<{ ARN?: string; VersionId?: string; DeletedDate?: Date; VersionIdsToStages?: Record<string, string[]> }>;
}
export interface TestAccountStsClient {
  send(command: AssumeRoleCommand): Promise<Pick<AssumeRoleCommandOutput, "Credentials">>;
}

export interface TestAccountSecretsInput {
  /** The install's environment name, which prefixes every secret name. */
  env: string;
  /** The TestAccountSecretsRole's ARN. */
  roleArn: string;
  /** Everything in a secret ARN up to and including `secret:` (`arn:aws:secretsmanager:<region>:<account>:secret:`). */
  secretArnPrefix: string;
  /** The region the secrets live in: the worker's client needs it. */
  region: string;
  sts: TestAccountStsClient;
  /** A Secrets Manager client that signs with these session credentials. */
  storeClientFor(credentials: SessionCredentials): StoreClient;
  /** The `ta` switch (`testAccountsEnabled`), read at every call: while it is off no session is minted and no secret is touched. */
  enabled(): boolean;
  now?: () => number;
}

/** What the worker needs to read one secret: a session limited to that read, the secret's name and when the session ends. The value is not in it. */
export interface ResolveGrant {
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
  secretName: string;
  region: string;
  expiresAt: string;
}

interface Session { client: StoreClient; expiresAt: number }
const errorName = (error: unknown): string | undefined => (error instanceof Error ? error.name : undefined);

/** The session policy of a resolve session: read this one secret (its name plus Secrets Manager's six-character suffix) and nothing else. */
export function resolveSessionPolicy(secretArnPrefix: string, secretName: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Action: "secretsmanager:GetSecretValue",
      Resource: `${secretArnPrefix}${secretName}-??????`,
      // Only the version the broker promoted: a pending (not yet committed) or previous version is never read. The reader names the stage in its request.
      Condition: { "ForAnyValue:StringEquals": { "secretsmanager:VersionStage": TEST_ACCOUNT_SECRET_VERSION_STAGE } },
    }],
  });
}

export class TestAccountSecrets {
  private readonly now: () => number;
  /** One store session (or one pending AssumeRole) per org. */
  private readonly sessions = new Map<OrgId, Promise<Session>>();

  constructor(private readonly input: TestAccountSecretsInput) {
    this.now = input.now ?? Date.now;
  }

  /**
   * Stores the account's secret as the JSON object `{ "<key>": "<value>" }` (the reference names the key), creating it with the two tags or, when it exists, adding a new version. Returns the version id.
   * It never calls TagResource or UntagResource itself, and never reads.
   */
  async put(orgId: string, accountId: string, key: string, value: string): Promise<string> {
    this.gate();
    const { org, name } = this.admit(orgId, accountId);
    if (!KEY.test(key)) throw agentXError("CONFIG_INVALID", "that is not a secret key name");
    if (value.length === 0 || value.length > VALUE_MAX) throw agentXError("CONFIG_INVALID", "that secret value is empty or too long");
    const body = JSON.stringify({ [key]: value });
    try {
      let response: { VersionId?: string };
      try {
        response = await this.run(org, (client) => client.send(new CreateSecretCommand({ Name: name, SecretString: body, Tags: Object.entries(testAccountSecretTags(org)).map(([Key, Value]) => ({ Key, Value })) })));
      } catch (error) {
        if (errorName(error) !== "ResourceExistsException") throw error;
        response = await this.run(org, (client) => client.send(new PutSecretValueCommand({ SecretId: name, SecretString: body })));
      }
      if (response.VersionId === undefined || response.VersionId === "") throw agentXError("RUNTIME_UNAVAILABLE", "the test account secret store did not say which version it saved");
      return response.VersionId;
    } catch (error) {
      // A secret scheduled for deletion refuses a new version as invalid; believed only when the secret says it is scheduled.
      if (errorName(error) === "InvalidRequestException" && await this.isScheduledForDeletion(org, name, false)) throw agentXError("CONFIG_INVALID", ACCOUNT_BEING_REMOVED_MESSAGE);
      throw this.refusal(error);
    }
  }

  /** Schedules the secret for deletion after a recovery window (7 to 30 days). A secret Secrets Manager cannot find is already gone. */
  async scheduleDelete(orgId: string, accountId: string, recoveryDays: number = DEFAULT_RECOVERY_DAYS): Promise<void> {
    this.gate();
    const { org, name } = this.admit(orgId, accountId);
    try {
      await this.run(org, (client) => client.send(new DeleteSecretCommand({ SecretId: name, RecoveryWindowInDays: recoveryDays })));
    } catch (error) {
      if (errorName(error) === "ResourceNotFoundException") return;
      if (errorName(error) === "InvalidRequestException" && await this.isScheduledForDeletion(org, name, true)) return;
      throw this.refusal(error);
    }
  }

  /**
   * ROTATION, step 1: puts a new value as a version staged `AWSPENDING`. `AWSCURRENT` stays where it was, so nothing that reads the secret sees the new value yet. Returns the new version id. The secret must exist.
   * Never reads.
   */
  async putPending(orgId: string, accountId: string, key: string, value: string): Promise<string> {
    this.gate();
    const { org, name } = this.admit(orgId, accountId);
    if (!KEY.test(key)) throw agentXError("CONFIG_INVALID", "that is not a secret key name");
    if (value.length === 0 || value.length > VALUE_MAX) throw agentXError("CONFIG_INVALID", "that secret value is empty or too long");
    try {
      const response = await this.run(org, (client) => client.send(new PutSecretValueCommand({ SecretId: name, SecretString: JSON.stringify({ [key]: value }), VersionStages: [TEST_ACCOUNT_SECRET_PENDING_STAGE] })));
      if (response.VersionId === undefined || response.VersionId === "") throw agentXError("RUNTIME_UNAVAILABLE", "the test account secret store did not say which version it saved");
      return response.VersionId;
    } catch (error) {
      if (errorName(error) === "InvalidRequestException" && await this.isScheduledForDeletion(org, name, false)) throw agentXError("CONFIG_INVALID", ACCOUNT_BEING_REMOVED_MESSAGE);
      throw this.refusal(error);
    }
  }

  /**
   * ROTATION, step 2 (after the row that records `versionId` is committed): moves `AWSCURRENT` to that version. The version that held it keeps `AWSPREVIOUS` (Secrets Manager does that itself). A version that is
   * not the pending one is refused, so a stale id cannot promote something else.
   */
  async promote(orgId: string, accountId: string, versionId: string): Promise<void> {
    this.gate();
    const { org, name } = this.admit(orgId, accountId);
    try {
      const described = await this.run(org, (client) => client.send(new DescribeSecretCommand({ SecretId: name })));
      const stages = described.VersionIdsToStages ?? {};
      if (!(stages[versionId] ?? []).includes(TEST_ACCOUNT_SECRET_PENDING_STAGE)) throw agentXError("CHANGE_STALE", "that secret version is not the pending one");
      const holder = Object.entries(stages).find(([, labels]) => labels.includes(TEST_ACCOUNT_SECRET_VERSION_STAGE))?.[0];
      await this.run(org, (client) => client.send(new UpdateSecretVersionStageCommand({
        SecretId: name, VersionStage: TEST_ACCOUNT_SECRET_VERSION_STAGE, MoveToVersionId: versionId, ...(holder === undefined ? {} : { RemoveFromVersionId: holder }),
      })));
    } catch (error) {
      throw this.refusal(error);
    }
    // The promotion is done. The pending label no longer means anything on the version that now serves, so it comes off (best effort: a label left behind changes nothing that is read).
    await this.discardPending(orgId, accountId, versionId).catch(() => undefined);
  }

  /** Takes `AWSPENDING` off a version that will not be promoted (the row was not committed). Best effort for the caller; `AWSCURRENT` is not touched. */
  async discardPending(orgId: string, accountId: string, versionId: string): Promise<void> {
    this.gate();
    const { org, name } = this.admit(orgId, accountId);
    try {
      await this.run(org, (client) => client.send(new UpdateSecretVersionStageCommand({ SecretId: name, VersionStage: TEST_ACCOUNT_SECRET_PENDING_STAGE, RemoveFromVersionId: versionId })));
    } catch (error) {
      if (errorName(error) === "ResourceNotFoundException") return;
      throw this.refusal(error);
    }
  }

  /**
   * A session for the worker of one sealed round, to read this one account's secret: tagged with the org and the purpose `resolve`, narrowed by a session policy to the one secret and the one action, 15
   * minutes. Nothing is read here. The caller has already decided the account may be used (`resolveAccountsForRound`).
   */
  async mintResolveGrant(orgId: string, accountId: string): Promise<ResolveGrant> {
    this.gate();
    const { org, name } = this.admit(orgId, accountId);
    let response: Pick<AssumeRoleCommandOutput, "Credentials">;
    try {
      response = await this.input.sts.send(new AssumeRoleCommand({
        RoleArn: this.input.roleArn,
        RoleSessionName: `resolve-${org}`,
        DurationSeconds: TEST_ACCOUNT_GRANT_SECONDS,
        Tags: [{ Key: TEST_ACCOUNT_SECRET_TAG_KEYS.org, Value: org }, { Key: "rovara:purpose", Value: "resolve" }],
        Policy: resolveSessionPolicy(this.input.secretArnPrefix, name),
      }));
    } catch (error) {
      throw this.refusal(error);
    }
    const credentials = response.Credentials;
    if (credentials?.AccessKeyId === undefined || credentials.SecretAccessKey === undefined || credentials.SessionToken === undefined || credentials.Expiration === undefined) {
      throw agentXError("RUNTIME_UNAVAILABLE", "the test account secrets role gave no credentials");
    }
    const expiresAt = credentials.Expiration.getTime();
    // A session longer than the 15 minutes asked for, or already over, is not handed to a worker.
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now() || expiresAt > this.now() + (TEST_ACCOUNT_GRANT_SECONDS + 60) * 1_000) throw agentXError("RUNTIME_UNAVAILABLE", "the test account secrets role gave an unusable session");
    return {
      credentials: { accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken },
      secretName: name,
      region: this.input.region,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  private gate(): void {
    if (!this.input.enabled()) throw agentXError("NOT_FOUND", "Not found");
  }

  private async isScheduledForDeletion(org: OrgId, name: string, goneCounts: boolean): Promise<boolean> {
    try {
      const described = await this.run(org, (client) => client.send(new DescribeSecretCommand({ SecretId: name })));
      return described.DeletedDate !== undefined;
    } catch (error) {
      return goneCounts && errorName(error) === "ResourceNotFoundException";
    }
  }

  /** The org id and the account id as parts of one name, checked before anything is sent to AWS. */
  private admit(orgId: string, accountId: string): { org: OrgId; name: string } {
    const parsed = OrgIdSchema.safeParse(orgId);
    if (!parsed.success || !TestAccountIdSchema.safeParse(accountId).success) throw agentXError("FORBIDDEN", "that secret does not belong to this organization");
    return { org: parsed.data, name: testAccountSecretName(this.input.env, parsed.data, accountId) };
  }

  private async run<T>(org: OrgId, call: (client: StoreClient) => Promise<T>): Promise<T> {
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
        if (this.sessions.get(org) === cached) this.sessions.delete(org);
        return this.session(org);
      });
    }
    const created = this.assumeStore(org);
    this.sessions.set(org, created);
    created.catch(() => { if (this.sessions.get(org) === created) this.sessions.delete(org); });
    return created;
  }

  private async assumeStore(org: OrgId): Promise<Session> {
    const response = await this.input.sts.send(new AssumeRoleCommand({
      RoleArn: this.input.roleArn,
      RoleSessionName: `store-${org}`,
      DurationSeconds: SESSION_SECONDS,
      Tags: [{ Key: TEST_ACCOUNT_SECRET_TAG_KEYS.org, Value: org }, { Key: "rovara:purpose", Value: "store" }],
    }));
    const credentials = response.Credentials;
    if (credentials?.AccessKeyId === undefined || credentials.SecretAccessKey === undefined || credentials.SessionToken === undefined || credentials.Expiration === undefined) {
      throw agentXError("RUNTIME_UNAVAILABLE", "the test account secrets role gave no credentials");
    }
    return {
      client: this.input.storeClientFor({ accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken, expiration: credentials.Expiration }),
      expiresAt: credentials.Expiration.getTime(),
    };
  }

  /** An AWS failure as a coded error that names its class and nothing else: an SDK message could quote request content. */
  private refusal(error: unknown): Error {
    if (error instanceof Error && error.name === "AgentXError") return error;
    const name = errorName(error) ?? "unknown";
    if (name === "AccessDeniedException" || name === "AccessDenied") return agentXError("FORBIDDEN", "the test account secrets role refused the request");
    return agentXError("RUNTIME_UNAVAILABLE", `the test account secret store failed (${name})`);
  }
}

export { TEST_ACCOUNT_SECRET_USE };
