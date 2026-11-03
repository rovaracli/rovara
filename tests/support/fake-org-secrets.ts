// A Secrets Manager and STS fake that ENFORCES the connector secrets role's trust policy and permissions
// policy, so a test proves org isolation instead of assuming it. The two policies are the ones the control
// plane synthesizes (infra/lib/connector-secrets-policy.ts); the fake evaluates them with a small IAM engine:
// an explicit Deny beats an Allow, no Allow is an implicit deny, and a condition operator the engine does not
// know is an error, never a silent pass. Supported: StringEquals, StringNotEquals, StringLike, Null, Bool, ForAllValues:StringEquals, ForAnyValue:StringEquals.
//
// Simplifications. This is NOT a model of real IAM, so it is no proof of how AWS treats wildcards or variables:
//  - A policy variable such as ${aws:PrincipalTag/rovara:org} is replaced by the session's tag value as plain text
//    before matching. Real IAM substitutes it too, but the fake does not model what happens when the value holds a
//    wildcard or a character a policy treats specially.
//  - STS session-tag validation is not modelled: real STS allows only letters, digits, spaces and _ . : / = + - @ in a
//    tag value (and rejects "*" and "?"). Here OrgSecrets pins the org id's character set before any call, so a
//    wildcard never reaches the fake.
//  - StringLike and resource globs treat "*" and "?" as the only special characters; there is no case-insensitive
//    operator, no IfExists, no NotAction or NotResource, no permissions boundary and no SCP.
//  - ForAllValues is true when the key is absent, as in real IAM, and TagSession is checked only when tags are sent.
//  - A secret ARN is matched by name prefix; Secrets Manager's random six-character ARN suffix is not generated.
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateSecretVersionStageCommand,
} from "@aws-sdk/client-secrets-manager";
import type { AssumeRoleCommand } from "@aws-sdk/client-sts";
import {
  connectorSecretsPolicyStatements,
  connectorSecretsTrustPolicy,
  type PolicyStatementJson,
} from "../../infra/lib/connector-secrets-policy.js";
import type { AssumedCredentials, SecretsCommand, StsClient } from "../../packages/broker/src/connections/org-secrets.js";

type Context = Record<string, string[] | undefined>;
type Tags = Record<string, string>;

/** What a test may send: the calls OrgSecrets makes, and the two it never makes, to prove the role refuses them. */
export type FakeSecretsCommand = SecretsCommand | TagResourceCommand | UntagResourceCommand | UpdateSecretVersionStageCommand;

export interface FakeSecretsClient {
  send(command: FakeSecretsCommand): Promise<{ SecretString?: string; ARN?: string; VersionId?: string; DeletedDate?: Date; VersionIdsToStages?: Record<string, string[]> }>;
}

export interface FakeCall {
  service: "sts" | "secretsmanager";
  action: string;
  /** The org the calling session was tagged with. */
  sessionOrg?: string;
  name?: string;
}

interface StoredSecret {
  /** The current version's value (AWSCURRENT). */
  value: string;
  tags: Tags;
  versions: number;
  /** Every version written, by id: a version stays readable by its VersionId after a newer one becomes current. */
  history: Array<{ id: string; value: string }>;
  /** The staging labels by version id (AWSCURRENT, AWSPREVIOUS, AWSPENDING). `value` is always the AWSCURRENT version's text. */
  stages: Record<string, string[]>;
  deleteAt?: number;
}

interface Session {
  tags: Tags;
  expiresAt: number;
  /** The session policy the AssumeRole call passed: it can only narrow what the role allows (an explicit Deny in it wins, and an Allow in it is needed as well). */
  sessionPolicy?: PolicyStatementJson[];
}

export interface FakeOrgSecretsOptions {
  env?: string;
  /** The role the fake serves (default: the connector secrets role). A test of another role passes its ARN, policy and trust. */
  roleArn?: string;
  now?: () => number;
  /** Replaces the permissions policy, to prove a missing allow is felt (default: the synthesized one). */
  policy?: PolicyStatementJson[];
  /** Replaces the trust policy's statements. */
  trust?: PolicyStatementJson[];
}

const REGION = "us-west-2";
const ACCOUNT = "111122223333";
const ARN_PREFIX = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:`;
const SUFFIX = "-AbCdEf";
export const FAKE_BROKER_ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/broker-function-role`;
export const FAKE_CONNECTOR_ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/connector-secrets-role`;

class AwsError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

const asList = (value: string | string[] | undefined): string[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "u");
}

/** A policy variable replaced by its value; an unset variable never matches. */
function substitute(text: string, context: Context): string {
  return text.replace(/\$\{([^}]+)\}/g, (_match, key: string) => context[key]?.[0] ?? "\u0000unset");
}

/** A Resource pattern against an ARN. A substituted policy variable is taken literally: a `*` in a tag is not a wildcard. */
function matchesGlob(text: string, pattern: string, context: Context): boolean {
  let source = "";
  for (const part of pattern.split(/(\$\{[^}]+\})/u)) {
    if (part.startsWith("${")) {
      const value = context[part.slice(2, -1)]?.[0];
      if (value === undefined) return false;
      source += value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else {
      source += part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    }
  }
  return new RegExp(`^${source}$`, "u").test(text);
}

function conditionHolds(condition: Record<string, Record<string, string | string[]>> | undefined, context: Context): boolean {
  if (condition === undefined) return true;
  for (const [operator, keys] of Object.entries(condition)) {
    for (const [key, expectedRaw] of Object.entries(keys)) {
      const actual = context[key];
      const expected = asList(expectedRaw).map((value) => substitute(value, context));
      let holds: boolean;
      switch (operator) {
        case "StringEquals":
          holds = actual !== undefined && actual.some((value) => expected.includes(value));
          break;
        case "StringLike":
          holds = actual !== undefined && actual.some((value) => expected.some((pattern) => globToRegExp(pattern).test(value)));
          break;
        case "Null":
          holds = expected[0] === "true" ? actual === undefined : actual !== undefined;
          break;
        case "Bool":
          holds = actual !== undefined && actual.some((value) => value === expected[0]);
          break;
        case "StringNotEquals":
          holds = actual === undefined || !actual.some((value) => expected.includes(value));
          break;
        case "ForAllValues:StringEquals":
          holds = actual === undefined || actual.every((value) => expected.includes(value));
          break;
        case "ForAnyValue:StringEquals":
          // False when the key is absent, as in real IAM.
          holds = actual !== undefined && actual.some((value) => expected.includes(value));
          break;
        default:
          throw new Error(`the fake IAM engine does not know the condition operator ${operator}`);
      }
      if (!holds) return false;
    }
  }
  return true;
}

type Decision = "allow" | "deny" | "implicit-deny";

function evaluate(statements: PolicyStatementJson[], action: string, resource: string | undefined, context: Context, principal?: string): Decision {
  let allowed = false;
  for (const statement of statements) {
    if (!asList(statement.Action).includes(action)) continue;
    if (principal !== undefined && statement.Principal !== undefined) {
      const principals = asList((statement.Principal as { AWS?: string | string[] }).AWS);
      if (!principals.includes(principal)) continue;
    }
    if (resource !== undefined && statement.Resource !== undefined && !asList(statement.Resource).some((pattern) => pattern === "*" || matchesGlob(resource, pattern, context))) continue;
    if (!conditionHolds(statement.Condition, context)) continue;
    if (statement.Effect === "Deny") return "deny";
    allowed = true;
  }
  return allowed ? "allow" : "implicit-deny";
}

function tagContext(tags: Tags | undefined): Context {
  if (tags === undefined || Object.keys(tags).length === 0) return {};
  const context: Context = { "aws:TagKeys": Object.keys(tags) };
  for (const [key, value] of Object.entries(tags)) context[`aws:RequestTag/${key}`] = [value];
  return context;
}

const tagList = (tags: ReadonlyArray<{ Key?: string | undefined; Value?: string | undefined }> | undefined): Tags | undefined =>
  tags === undefined ? undefined : Object.fromEntries(tags.map((tag) => [tag.Key ?? "", tag.Value ?? ""]));

export class FakeOrgSecrets {
  readonly env: string;
  readonly roleArn: string;
  readonly calls: FakeCall[] = [];
  readonly secrets = new Map<string, StoredSecret>();
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;
  private readonly policy: PolicyStatementJson[];
  private readonly trust: PolicyStatementJson[];
  private counter = 0;

  constructor(options: FakeOrgSecretsOptions = {}) {
    this.env = options.env ?? "staging";
    this.roleArn = options.roleArn ?? FAKE_CONNECTOR_ROLE_ARN;
    this.now = options.now ?? Date.now;
    this.policy = options.policy ?? connectorSecretsPolicyStatements({ secretArnPrefix: ARN_PREFIX, env: this.env });
    this.trust = options.trust ?? (connectorSecretsTrustPolicy(FAKE_BROKER_ROLE_ARN).Statement);
  }

  /** The STS the broker uses: AssumeRole is allowed only as the trust policy allows it. */
  readonly sts: StsClient = {
    send: async (command: AssumeRoleCommand) => {
      const input = command.input;
      this.calls.push({ service: "sts", action: "AssumeRole" });
      if (input.RoleArn !== this.roleArn) throw new AwsError("AccessDenied", "no such role");
      const tags = tagList(input.Tags);
      const context = tagContext(tags);
      // sts:AssumeRole with session tags also needs sts:TagSession; both are checked against the trust policy.
      for (const action of ["sts:AssumeRole", ...(tags === undefined ? [] : ["sts:TagSession"])]) {
        if (evaluate(this.trust, action, undefined, context, FAKE_BROKER_ROLE_ARN) !== "allow") {
          throw new AwsError("AccessDenied", "the role's trust policy does not allow this session");
        }
      }
      if ((input.DurationSeconds ?? 3600) > 3600) throw new AwsError("ValidationError", "duration too long");
      const id = `ASIAFAKE${String(++this.counter).padStart(8, "0")}`;
      const expiresAt = this.now() + (input.DurationSeconds ?? 3600) * 1000;
      const sessionPolicy = input.Policy === undefined ? undefined : (JSON.parse(input.Policy) as { Statement: PolicyStatementJson[] }).Statement;
      this.sessions.set(id, { tags: tags ?? {}, expiresAt, ...(sessionPolicy === undefined ? {} : { sessionPolicy }) });
      return { Credentials: { AccessKeyId: id, SecretAccessKey: `secret-${id}`, SessionToken: `token-${id}`, Expiration: new Date(expiresAt) } };
    },
  };

  /** A Secrets Manager client holding the session these credentials name. */
  readonly secretsFor = (credentials: AssumedCredentials): FakeSecretsClient => {
    const session = this.sessions.get(credentials.accessKeyId);
    return { send: async (command: FakeSecretsCommand) => this.handle(session, command) };
  };

  /** A client for the session an AssumeRole as `orgId` returns, for a test that attacks the role directly. */
  async client(orgId: string, tagKeys: Tags = { "rovara:org": orgId }): Promise<FakeSecretsClient> {
    const { AssumeRoleCommand } = await import("@aws-sdk/client-sts");
    const response = await this.sts.send(new AssumeRoleCommand({
      RoleArn: this.roleArn, RoleSessionName: "test", DurationSeconds: 900, Tags: Object.entries(tagKeys).map(([Key, Value]) => ({ Key, Value })),
    }));
    const credentials = response.Credentials!;
    return this.secretsFor({ accessKeyId: credentials.AccessKeyId!, secretAccessKey: credentials.SecretAccessKey!, sessionToken: credentials.SessionToken!, expiration: credentials.Expiration! });
  }

  /** Puts a secret in place without any IAM check, as an administrator or a past write would have. */
  seed(name: string, value: string, tags: Tags): void {
    const id = this.versionId();
    this.secrets.set(name, { value, tags, versions: 1, history: [{ id, value }], stages: { [id]: ["AWSCURRENT"] } });
  }

  private versionId(): string {
    return `00000000-0000-4000-8000-${String(++this.counter).padStart(12, "0")}`;
  }

  stored(name: string): { value: string; tags: Tags; versions: number; history: Array<{ id: string; value: string }>; stages: Record<string, string[]>; deleteAt?: number } | undefined {
    return this.secrets.get(name);
  }

  /** Attaches a label to a version. A label already on a different version moves only when the caller names that version (UpdateSecretVersionStage) or the call is a put (which moves it, as Secrets Manager does). AWSCURRENT moving leaves AWSPREVIOUS behind. */
  private attach(secret: StoredSecret, label: string, to: string, from: string | undefined, isPut = false): void {
    const holder = Object.entries(secret.stages).find(([, labels]) => labels.includes(label))?.[0];
    if (holder !== undefined && holder !== to && from === undefined && !isPut) throw new AwsError("InvalidParameterException", "the label is attached to another version: name it in RemoveFromVersionId");
    if (holder !== undefined && holder !== to) {
      secret.stages[holder] = (secret.stages[holder] ?? []).filter((each) => each !== label);
      if (label === "AWSCURRENT") {
        for (const id of Object.keys(secret.stages)) secret.stages[id] = (secret.stages[id] ?? []).filter((each) => each !== "AWSPREVIOUS");
        secret.stages[holder] = [...(secret.stages[holder] ?? []), "AWSPREVIOUS"];
      }
    }
    secret.stages[to] = [...new Set([...(secret.stages[to] ?? []), label])];
    this.syncCurrent(secret);
  }

  private syncCurrent(secret: StoredSecret): void {
    const current = secret.history.find((version) => (secret.stages[version.id] ?? []).includes("AWSCURRENT"));
    if (current !== undefined) secret.value = current.value;
  }

  private nameOf(secretId: string): string {
    if (!secretId.startsWith(ARN_PREFIX)) return secretId;
    const rest = secretId.slice(ARN_PREFIX.length);
    return /-[A-Za-z0-9]{6}$/.test(rest) ? rest.slice(0, -SUFFIX.length) : rest;
  }

  private arnOf(name: string): string {
    return `${ARN_PREFIX}${name}${SUFFIX}`;
  }

  private authorize(session: Session, action: string, name: string, requestTags: Tags | undefined, resourceTags: Tags | undefined, extra: Context = {}): void {
    const context: Context = { ...extra, ...tagContext(requestTags), "aws:PrincipalTag/rovara:org": session.tags["rovara:org"] === undefined ? undefined : [session.tags["rovara:org"]] };
    // Every session tag is a principal tag (the purpose tag of the test-account role is one).
    for (const [key, value] of Object.entries(session.tags)) context[`aws:PrincipalTag/${key}`] = [value];
    for (const [key, value] of Object.entries(resourceTags ?? {})) context[`aws:ResourceTag/${key}`] = [value];
    const resource = this.arnOf(name);
    const action_ = `secretsmanager:${action}`;
    if (evaluate(this.policy, action_, resource, context) !== "allow" || (session.sessionPolicy !== undefined && evaluate(session.sessionPolicy, action_, resource, context) !== "allow")) {
      throw new AwsError("AccessDeniedException", `User is not authorized to perform secretsmanager:${action}`);
    }
  }

  private handle(session: Session | undefined, command: FakeSecretsCommand): Promise<{ SecretString?: string; ARN?: string; VersionId?: string; DeletedDate?: Date; VersionIdsToStages?: Record<string, string[]> }> {
    const action = command.constructor.name.replace(/Command$/, "");
    const input = command.input as unknown as Record<string, unknown>;
    return Promise.resolve().then(() => {
      if (session === undefined) throw new AwsError("InvalidClientTokenId", "unknown credentials");
      if (this.now() >= session.expiresAt) throw new AwsError("ExpiredTokenException", "the security token is expired");
      const name = action === "CreateSecret" ? String(input.Name) : this.nameOf(String(input.SecretId));
      const sessionOrg = session.tags["rovara:org"];
      this.calls.push({ service: "secretsmanager", action, ...(sessionOrg === undefined ? {} : { sessionOrg }), name });
      const existing = this.secrets.get(name);
      if (command instanceof CreateSecretCommand) {
        const tags = tagList(command.input.Tags);
        this.authorize(session, "CreateSecret", name, tags, undefined);
        // "If you include tags in the secret, you also need secretsmanager:TagResource."
        if (tags !== undefined) this.authorize(session, "TagResource", name, tags, undefined);
        if (existing !== undefined) throw new AwsError("ResourceExistsException", "the secret already exists");
        const value = command.input.SecretString ?? "";
        const id = this.versionId();
        this.secrets.set(name, { value, tags: tags ?? {}, versions: 1, history: [{ id, value }], stages: { [id]: ["AWSCURRENT"] } });
        return { ARN: this.arnOf(name), VersionId: id };
      }
      if (command instanceof TagResourceCommand) {
        const tags = tagList(command.input.Tags);
        this.authorize(session, "TagResource", name, tags, existing?.tags);
        if (existing === undefined) throw new AwsError("ResourceNotFoundException", "no such secret");
        Object.assign(existing.tags, tags);
        return {};
      }
      if (command instanceof UntagResourceCommand) {
        this.authorize(session, "UntagResource", name, undefined, existing?.tags);
        if (existing === undefined) throw new AwsError("ResourceNotFoundException", "no such secret");
        for (const key of command.input.TagKeys ?? []) delete existing.tags[key];
        return {};
      }
      const known = command instanceof GetSecretValueCommand || command instanceof PutSecretValueCommand || command instanceof DescribeSecretCommand || command instanceof DeleteSecretCommand || command instanceof UpdateSecretVersionStageCommand;
      if (!known) throw new AwsError("AccessDeniedException", `${action} is not an action the fake supports`);
      // The request's own condition keys (secretsmanager:ForceDeleteWithoutRecovery is present, as "true" or "false", on every DeleteSecret).
      const requestKeys: Context = command instanceof DeleteSecretCommand ? { "secretsmanager:ForceDeleteWithoutRecovery": [String(command.input.ForceDeleteWithoutRecovery === true)] } : {};
      // The version stage the request names, when it names one (a request that omits it carries no such key here: the conservative reading of what IAM sees).
      if (command instanceof GetSecretValueCommand && command.input.VersionStage !== undefined) requestKeys["secretsmanager:VersionStage"] = [command.input.VersionStage];
      if (command instanceof UpdateSecretVersionStageCommand) requestKeys["secretsmanager:VersionStage"] = [command.input.VersionStage ?? ""];
      if (command instanceof PutSecretValueCommand && command.input.VersionStages !== undefined) requestKeys["secretsmanager:VersionStage"] = [...command.input.VersionStages];
      this.authorize(session, action, name, undefined, existing?.tags, requestKeys);
      if (existing === undefined) throw new AwsError("ResourceNotFoundException", "Secrets Manager can't find the specified secret.");
      if (existing.deleteAt !== undefined && !(command instanceof DescribeSecretCommand)) {
        throw new AwsError("InvalidRequestException", "You can't perform this operation on the secret because it was marked for deletion.");
      }
      if (command instanceof GetSecretValueCommand) {
        const wanted = command.input.VersionId;
        if (wanted === undefined) {
          const stage = command.input.VersionStage ?? "AWSCURRENT";
          if (stage === "AWSCURRENT") return { SecretString: existing.value };
          const byStage = existing.history.find((version) => (existing.stages[version.id] ?? []).includes(stage));
          if (byStage === undefined) throw new AwsError("ResourceNotFoundException", "Secrets Manager can't find the specified secret value for staging label.");
          return { SecretString: byStage.value, VersionId: byStage.id };
        }
        const found = existing.history.find((version) => version.id === wanted);
        if (found === undefined) throw new AwsError("ResourceNotFoundException", "Secrets Manager can't find the specified secret value for VersionId.");
        return { SecretString: found.value, VersionId: found.id };
      }
      if (command instanceof PutSecretValueCommand) {
        const text = command.input.SecretString ?? "";
        existing.versions += 1;
        const id = this.versionId();
        existing.history.push({ id, value: text });
        const labels = command.input.VersionStages ?? ["AWSCURRENT"];
        existing.stages[id] = [];
        for (const label of labels) this.attach(existing, label, id, undefined, true);
        return { VersionId: id };
      }
      if (command instanceof UpdateSecretVersionStageCommand) {
        const label = command.input.VersionStage ?? "";
        const from = command.input.RemoveFromVersionId;
        const to = command.input.MoveToVersionId;
        if (from !== undefined && !(existing.stages[from] ?? []).includes(label)) throw new AwsError("InvalidParameterException", "the label is not attached to that version");
        if (to !== undefined && existing.stages[to] === undefined) throw new AwsError("ResourceNotFoundException", "no such version");
        if (to === undefined) {
          if (from !== undefined) existing.stages[from] = (existing.stages[from] ?? []).filter((each) => each !== label);
          this.syncCurrent(existing);
          return { ARN: this.arnOf(name) };
        }
        this.attach(existing, label, to, from);
        return { ARN: this.arnOf(name) };
      }
      if (command instanceof DescribeSecretCommand) return { ARN: this.arnOf(name), VersionIdsToStages: Object.fromEntries(Object.entries(existing.stages).filter(([, labels]) => labels.length > 0)), ...(existing.deleteAt === undefined ? {} : { DeletedDate: new Date(existing.deleteAt) }) };
      if (command instanceof DeleteSecretCommand) {
        const days = command.input.RecoveryWindowInDays ?? 30;
        if (command.input.ForceDeleteWithoutRecovery === true || days < 7 || days > 30) throw new AwsError("InvalidParameterException", "invalid recovery window");
        existing.deleteAt = this.now() + days * 86_400_000;
        return {};
      }
      return {};
    });
  }
}
