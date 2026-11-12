// Customer test AWS account, lane TA2: every AWS call this lane makes, as a port. Nothing else in the lane imports an AWS SDK, so the logic is tested without AWS, and the real adapter (`aws-sdk.ts`) is the one place that sends.
// A result is a fixed word, never text from AWS: AWS's messages can name resources and accounts, and they are never kept or shown.

export interface AssumedCredentials { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date }

/** What `AssumeRole` is asked. Only these fields exist, so no caller can add `SourceIdentity`, a transitive tag, or a managed policy. */
export interface AssumeRoleRequest {
  RoleArn: string;
  RoleSessionName: string;
  ExternalId?: string;
  DurationSeconds: number;
  Policy?: string;
  Tags?: Array<{ Key: string; Value: string }>;
}
export interface AssumedRole { credentials: AssumedCredentials; assumedRoleArn: string | undefined }

/** `refused`: AWS said access denied (the role is not there, does not trust Rovara, or the external id is wrong). `unreachable`: anything else. */
export type AssumeFailure = "refused" | "unreachable";

export type ServiceProbe = "ok" | "scp_blocked" | "no_access" | "unreachable" | "no_client";
export type DeleteOutcome = "deleted" | "denied" | "not_found" | "error";

/** The calls made with an assumed session, in one Region. Each is one harmless read, or the one create and delete of the connection test. */
export interface AccountCalls {
  /** `iam:ListAccountAliases`. Empty when the account has none, or when the call is refused. */
  listAccountAliases(): Promise<string[]>;
  /** The permissions boundary ARN of a role of this account (`iam:GetRole`), or undefined. */
  roleBoundary(roleName: string): Promise<string | undefined>;
  /** One harmless read of a service in the connection's Region. */
  probeService(service: string): Promise<ServiceProbe>;
  /** The names of one service's existing resources (one list call), at most `limit`; undefined when the call is refused. */
  listNames(service: string, limit: number): Promise<string[] | undefined>;
  /** Creates a queue named `name` carrying the run tag. Returns its URL, or a fixed refusal word. */
  createQueue(name: string, runId: string): Promise<{ ok: true; queueUrl: string } | { ok: false; code: "denied" | "error" }>;
  deleteQueueByName(name: string): Promise<DeleteOutcome>;
  deleteQueueByUrl(queueUrl: string): Promise<DeleteOutcome>;
}

export interface TestAccessAws {
  /** Throws an `AssumeFailureError`. */
  assumeRole(request: AssumeRoleRequest): Promise<AssumedRole>;
  /** The calls for one assumed session. Never reuses another session's credentials. */
  calls(credentials: AssumedCredentials, region: string, accountId: string): AccountCalls;
}

export class AssumeFailureError extends Error {
  constructor(readonly failure: AssumeFailure) {
    super(failure === "refused" ? "AWS refused the role" : "AWS could not be reached");
    this.name = "AssumeFailureError";
  }
}
