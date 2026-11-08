// R3 (review I-8): per-workspace credentials for the vector index. The broker role may assume a data role; each session carries a SESSION
// POLICY that reaches the one index of one workspace (`index/ws-<hash>`), so a bug that builds the wrong index name still cannot read or
// delete another workspace's vectors. The AWS adapter (STS AssumeRole with `Policy`) is pending; this file is the policy and the cache.
import { createHash } from "node:crypto";
import { AssumeRoleCommand, type STSClient } from "@aws-sdk/client-sts";
import { retiredTeamRecordVectorIndexName, teamRecordVectorIndexName } from "@agentx/contracts";
import { S3VectorsIndex, type S3VectorsPort } from "./s3-vectors-index.js";

export interface SessionPolicyInput {
  partition?: string;
  region: string;
  account: string;
  bucket: string;
  workspaceId: string;
  /** Public cells create the workspace's index at run time. */
  allowCreateIndex?: boolean;
  /** The customer's or the cell's key, when the bucket uses KMS. */
  kmsKeyArn?: string;
}

/** The inline session policy, as an object. AWS limits a packed session policy to 2,048 characters; the test keeps it under that. */
export function workspaceVectorSessionPolicy(input: SessionPolicyInput): { Version: string; Statement: Array<Record<string, unknown>> } {
  const index = teamRecordVectorIndexName(input.workspaceId);
  const partition = input.partition ?? "aws";
  const indexArn = `arn:${partition}:s3vectors:${input.region}:${input.account}:bucket/${input.bucket}/index/${index}`;
  const actions = ["s3vectors:PutVectors", "s3vectors:QueryVectors", "s3vectors:GetVectors", "s3vectors:DeleteVectors", "s3vectors:GetIndex"];
  const statement: Array<Record<string, unknown>> = [{ Effect: "Allow", Action: actions, Resource: indexArn }];
  // The one extra right: delete the workspace's index of the embedding generation before the current one (the retire step, and what an erase starts with).
  const retiredArn = `arn:${partition}:s3vectors:${input.region}:${input.account}:bucket/${input.bucket}/index/${retiredTeamRecordVectorIndexName(input.workspaceId)}`;
  statement.push({ Effect: "Allow", Action: ["s3vectors:DeleteIndex"], Resource: retiredArn });
  if (input.allowCreateIndex === true) statement.push({ Effect: "Allow", Action: ["s3vectors:CreateIndex"], Resource: indexArn });
  if (input.kmsKeyArn !== undefined) statement.push({ Effect: "Allow", Action: ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"], Resource: input.kmsKeyArn });
  return { Version: "2012-10-17", Statement: statement };
}

export interface AssumedVectorsPort {
  port: S3VectorsPort;
  expiresAtMs: number;
}

export interface WorkspaceVectorPortsOptions {
  /** AssumeRole on the data role with the given session policy (JSON text). Returns a port that uses those credentials. */
  assume: (request: { workspaceId: string; sessionPolicy: string }) => Promise<AssumedVectorsPort>;
  policyFor: (workspaceId: string, bucket: string) => SessionPolicyInput;
  now?: () => number;
  /** A session is replaced this long before it expires. Default 5 minutes. */
  refreshBeforeMs?: number;
  /** Bound on cached sessions (oldest dropped). Default 200. */
  maxEntries?: number;
}

/** One cached session per workspace and bucket. Never shares a session between workspaces. */
export class WorkspaceVectorPorts {
  private readonly cache = new Map<string, AssumedVectorsPort>();

  constructor(private readonly options: WorkspaceVectorPortsOptions) {}

  async get(workspaceId: string, bucket: string): Promise<S3VectorsPort> {
    const now = (this.options.now ?? Date.now)();
    const key = `${workspaceId}\u0000${bucket}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAtMs - (this.options.refreshBeforeMs ?? 300_000) > now) return cached.port;
    const policy = JSON.stringify(workspaceVectorSessionPolicy(this.options.policyFor(workspaceId, bucket)));
    if (policy.length > 2048) throw new Error("team-record: the session policy is too large");
    const assumed = await this.options.assume({ workspaceId, sessionPolicy: policy });
    this.cache.delete(key);
    this.cache.set(key, assumed);
    while (this.cache.size > (this.options.maxEntries ?? 200)) this.cache.delete(this.cache.keys().next().value as string);
    return assumed.port;
  }
}

// ---- The STS adapter and the way to open an index (review I-8: scoping per workspace is the default) -------------------------------------

export interface VectorCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/** STS AssumeRole with an inline session policy. */
export interface StsAssumePort {
  assumeRole(request: { roleArn: string; sessionName: string; policy: string; durationSeconds: number; tags?: ReadonlyArray<{ Key: string; Value: string }> }): Promise<{ credentials: VectorCredentials; expiresAtMs: number }>;
}

/** The real port over `@aws-sdk/client-sts`. Errors carry no text (the caller sees a fixed message). */
export function createStsAssumePort(client: Pick<STSClient, "send">): StsAssumePort {
  return {
    async assumeRole(request) {
      let output;
      try {
        output = await client.send(new AssumeRoleCommand({ RoleArn: request.roleArn, RoleSessionName: request.sessionName, Policy: request.policy, DurationSeconds: request.durationSeconds, ...(request.tags === undefined ? {} : { Tags: request.tags.map((tag) => ({ Key: tag.Key, Value: tag.Value })) }) }));
      } catch {
        throw new Error("team-record: could not assume the vector data role");
      }
      const c = output.Credentials;
      if (c?.AccessKeyId === undefined || c.SecretAccessKey === undefined || c.SessionToken === undefined || c.Expiration === undefined) {
        throw new Error("team-record: the vector data role session has no credentials");
      }
      return { credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken }, expiresAtMs: c.Expiration.getTime() };
    },
  };
}

/** Builds the `assume` function of WorkspaceVectorPorts: one STS session per workspace, carrying that workspace's session policy. */
export function createAssume(options: {
  sts: StsAssumePort;
  /** `TEAM_RECORD_VECTORS_ROLE_ARN` from the stack. */
  roleArn: string;
  /** Makes the S3 Vectors port that signs with these credentials. The SDK adapter (`@aws-sdk/client-s3vectors`) is pending. */
  portFromCredentials: (credentials: VectorCredentials) => S3VectorsPort;
  durationSeconds?: number;
}): WorkspaceVectorPortsOptions["assume"] {
  return async ({ workspaceId, sessionPolicy }) => {
    const sessionName = `team-record-${createHash("sha256").update(workspaceId).digest("hex").slice(0, 24)}`;
    // The session TAG names the one index the session may reach; the data role's own rights are written in terms of it (infra/lib/team-record-vectors.ts), so a session without it reaches nothing.
    const session = await options.sts.assumeRole({ roleArn: options.roleArn, sessionName, policy: sessionPolicy, durationSeconds: options.durationSeconds ?? 3600, tags: [{ Key: "rovara-index", Value: teamRecordVectorIndexName(workspaceId) }, { Key: "rovara-retired-index", Value: retiredTeamRecordVectorIndexName(workspaceId) }] });
    return { port: options.portFromCredentials(session.credentials), expiresAtMs: session.expiresAtMs };
  };
}

/**
 * The way to get a workspace's vector index: its port comes from a session scoped to that workspace's one index. Use this, not
 * `new S3VectorsIndex(...)` with a shared port, anywhere outside tests.
 */
export async function openWorkspaceIndex(input: { ports: WorkspaceVectorPorts; workspaceId: string; bucket: string; dimension: number }): Promise<S3VectorsIndex> {
  return new S3VectorsIndex({ port: await input.ports.get(input.workspaceId, input.bucket), bucket: input.bucket, workspaceId: input.workspaceId, dimension: input.dimension });
}
