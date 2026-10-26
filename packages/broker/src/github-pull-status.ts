// Rovara Code (Plan 6 Task 14): what GitHub says about one pull request for merge tracking, and the parsing of it. Pure functions over GitHub's JSON, so each answer is
// checked field by field before anything decides on it; an answer that does not fit throws (the tracking pass then tries again), it is never read as "fine".
import { agentXError } from "@agentx/contracts";

/** A check or status on the head: `pending` until it has finished. */
export type PullRequestCheckStatus = "pending" | "completed";
export type PullRequestCheckConclusion =
  | "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | "stale" | "startup_failure" | "error";

export interface PullRequestCheck {
  name: string;
  status: PullRequestCheckStatus;
  conclusion?: PullRequestCheckConclusion;
  /** Whether the base branch requires this check (GitHub's `isRequired` for this pull request). */
  required: boolean;
  url: string;
  /** The check run's database id, which is the job id of a GitHub Actions job. */
  jobId?: string;
}

export interface PullRequestReview {
  githubUserId: string;
  login: string;
  userType: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  commitId: string;
  submittedAt: string;
}

export type PullRequestMergeableState = "clean" | "dirty" | "behind" | "blocked" | "unstable" | "has_hooks" | "draft" | "unknown";

export interface PullRequestStatus {
  number: number;
  state: "open" | "closed" | "merged";
  draft: boolean;
  headSha: string;
  baseBranch: string;
  mergeableState: PullRequestMergeableState;
  /** GitHub's `mergeable` when it has worked it out: false means the branch conflicts with its base. Absent while GitHub is still working it out. */
  mergeable?: boolean;
  /** How many commits of the base the branch lacks, when it was worked out (it is not asked of a branch GitHub already calls dirty, behind or unknown). */
  behindBy?: number;
  checks: PullRequestCheck[];
  /** The checks could not be read (GitHub refused the checks/statuses access, or the list failed): they are not known, so no reading of them may say "passing". */
  checksUnavailable?: true;
  /** The names of the checks the base branch's protection requires (classic protection: contexts and checks), whether or not they have reported. */
  requiredCheckNames: string[];
  baseHasRequiredChecks: boolean;
  headHasWorkflowFiles: boolean;
  /** How many reviewers (people and teams) are asked for a review now. */
  requestedReviewers: number;
  reviews: PullRequestReview[];
}

const SHA = /^[a-f0-9]{40}$/;
const MAX_NAME = 200;
const CONTROL = /[\p{Cc}\p{Cf}]/gu;
const HAS_CONTROL = /[\p{Cc}\p{Cf}]/u;

function fail(reason: string): never {
  throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request status read refused: ${reason}`);
}

export function statusRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("invalid record");
  return value as Record<string, unknown>;
}

/** A name from GitHub as one short line: control and format characters taken out, cut at 200 characters. */
export function cleanName(value: unknown): string {
  if (typeof value !== "string") return fail("invalid name");
  const text = value.replace(CONTROL, " ").trim();
  return text.length === 0 ? fail("empty name") : [...text].slice(0, MAX_NAME).join("");
}

const MERGEABLE_STATES: ReadonlySet<string> = new Set(["clean", "dirty", "behind", "blocked", "unstable", "has_hooks", "draft", "unknown"]);

export function parseMergeableState(value: unknown): PullRequestMergeableState {
  // GitHub works the state out on first request and answers null until it has: that is "unknown", not an error.
  if (value === null || value === undefined) return "unknown";
  return typeof value === "string" && MERGEABLE_STATES.has(value) ? value as PullRequestMergeableState : "unknown";
}

const CONCLUSIONS: Readonly<Record<string, PullRequestCheckConclusion>> = {
  SUCCESS: "success", FAILURE: "failure", NEUTRAL: "neutral", CANCELLED: "cancelled", SKIPPED: "skipped", TIMED_OUT: "timed_out",
  ACTION_REQUIRED: "action_required", STALE: "stale", STARTUP_FAILURE: "startup_failure",
};

/** One node of the head commit's `statusCheckRollup.contexts`: a check run or a commit status. */
export function parseRollupContext(value: unknown): PullRequestCheck {
  const node = statusRecord(value);
  const required = node.isRequired === true;
  if (node.__typename === "CheckRun") {
    const completed = node.status === "COMPLETED";
    const conclusion = typeof node.conclusion === "string" ? CONCLUSIONS[node.conclusion] : undefined;
    // A finished run with a conclusion this reader does not know is not a pass.
    if (completed && conclusion === undefined) return fail("unknown check conclusion");
    const id = typeof node.databaseId === "number" && Number.isSafeInteger(node.databaseId) && node.databaseId > 0 ? String(node.databaseId) : undefined;
    return {
      name: cleanName(node.name), status: completed ? "completed" : "pending", ...(completed && conclusion !== undefined ? { conclusion } : {}),
      required, url: safeUrl(node.detailsUrl), ...(id === undefined ? {} : { jobId: id }),
    };
  }
  if (node.__typename === "StatusContext") {
    const state = node.state;
    if (state !== "EXPECTED" && state !== "ERROR" && state !== "FAILURE" && state !== "PENDING" && state !== "SUCCESS") return fail("unknown status state");
    const finished = state === "ERROR" || state === "FAILURE" || state === "SUCCESS";
    return {
      name: cleanName(node.context), status: finished ? "completed" : "pending",
      ...(finished ? { conclusion: state === "SUCCESS" ? "success" as const : state === "ERROR" ? "error" as const : "failure" as const } : {}),
      required, url: safeUrl(node.targetUrl),
    };
  }
  return fail("unknown check kind");
}

/** A link GitHub gave for a check: https only, at most 2,048 characters, or an empty string. */
function safeUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.toString() : "";
  } catch {
    return "";
  }
}

const REVIEW_STATES: ReadonlySet<string> = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]);

/** One review of `pulls/{n}/reviews`. A review that is not yet submitted (PENDING, no `submitted_at`) is not returned: it is the reviewer's draft. */
export function parseReview(value: unknown): PullRequestReview | undefined {
  const review = statusRecord(value);
  const user = review.user === null || review.user === undefined ? undefined : statusRecord(review.user);
  // A deleted account ("ghost") leaves a review with no user: it can be counted for nothing.
  if (user === undefined) return undefined;
  if (typeof review.state !== "string" || !REVIEW_STATES.has(review.state)) return fail("unknown review state");
  if (review.state === "PENDING" || typeof review.submitted_at !== "string") return undefined;
  const id = user.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return fail("invalid reviewer id");
  const login = user.login;
  if (typeof login !== "string" || login.length === 0 || login.length > 100 || HAS_CONTROL.test(login)) return fail("invalid reviewer login");
  const commit = review.commit_id;
  if (typeof commit !== "string" || !SHA.test(commit)) return fail("invalid review commit");
  const submittedAt = Date.parse(review.submitted_at);
  if (!Number.isFinite(submittedAt)) return fail("invalid review time");
  return {
    githubUserId: String(id), login, userType: typeof user.type === "string" ? user.type.slice(0, 20) : "", state: review.state as PullRequestReview["state"],
    commitId: commit, submittedAt: new Date(submittedAt).toISOString(),
  };
}

/** What the permission endpoint answers, as the four words tracking uses. `maintain` reads as `write`. */
export function parseRepositoryPermission(value: unknown): "admin" | "write" | "read" | "none" {
  const body = statusRecord(value);
  if (body.role_name === "maintain") return "write";
  const permission = body.permission;
  if (permission === "admin" || permission === "write" || permission === "read" || permission === "none") return permission;
  // `triage` and anything else a repository role can be: below write.
  return typeof permission === "string" ? "read" : fail("invalid permission answer");
}

export function requestedReviewerCount(pull: Record<string, unknown>): number {
  const count = (value: unknown): number => Array.isArray(value) ? value.length : 0;
  return count(pull.requested_reviewers) + count(pull.requested_teams);
}
