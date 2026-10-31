// R3 (review I-8): per-workspace credentials for the vector index. The broker role may assume a data role; each session carries a SESSION
// POLICY that reaches the one index of one workspace (`index/ws-<hash>`), so a bug that builds the wrong index name still cannot read or
// delete another workspace's vectors. The AWS adapter (STS AssumeRole with `Policy`) is pending; this file is the policy and the cache.
import { teamRecordVectorIndexName } from "@agentx/contracts";
import type { S3VectorsPort } from "./s3-vectors-index.js";

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
