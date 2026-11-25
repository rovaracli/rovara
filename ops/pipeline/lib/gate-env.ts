// What the L5 gates need from the build environment and from the Code clone, read through ports only (a fake in tests, nothing real touched).
import type { Manifest, PipelineEnv, Ports } from "../types.ts";

/** An environment variable of the build, through the exec port (the gate interface has no environment of its own). Unset or empty: null. */
export async function envValue(ports: Ports, name: string): Promise<string | null> {
  const run = await ports.exec("printenv", [name]);
  if (run.code !== 0) return null;
  const value = run.stdout.trim();
  return value === "" ? null : value;
}

/** The directory of a full clone of Rovara Code that the build action provides (the Code source artifact). */
export const CODE_REPO_ENV = "ROVARA_CODE_REPO";
/** The explicit first-release flag: the Cloud sha believed live when the environment has no DeployedCloudSha output yet. */
export const ADOPT_DEPLOYED_SHA_ENV = "ROVARA_ADOPT_DEPLOYED_CLOUD_SHA";

export interface CodeShaChoice { sha: string | null; why: string }

/**
 * The Code commit that will be live in the environment when this run is done. A run that releases Code: the Code commit of the run.
 * A run that skips Code (a Cloud-first release, or a rollback): the Code that stays, the rollback pin or CODE_LIVE_SHA (recorded in the rollback record).
 * Never a guess: null with the reason when it is not known.
 */
export function codeShaThatWillBeLive(manifest: Readonly<Manifest>, env: PipelineEnv): CodeShaChoice {
  if (manifest.code.release === "run") {
    return manifest.code.sha === null ? { sha: null, why: "this run releases Code but has no CODE_SHA" } : { sha: manifest.code.sha, why: "Code release run: the commit this run promotes" };
  }
  const pinned = manifest.code.pinnedSha[env];
  if (pinned !== null) return { sha: pinned, why: "Code is skipped and pinned to what is live" };
  const live = manifest.stages[env]?.rollback?.code.liveSha ?? null;
  if (live !== null) return { sha: live, why: "Code is skipped: the Code sha live in this environment (CODE_LIVE_SHA)" };
  return { sha: null, why: "Code is skipped, so the check needs the Code sha that is live (CODE_LIVE_SHA), and none was given" };
}

/** Whether a commit exists in a clone (git cat-file). */
export async function commitInRepo(ports: Ports, repo: string, sha: string): Promise<boolean> {
  return (await ports.exec("git", ["-C", repo, "cat-file", "-e", `${sha}^{commit}`])).code === 0;
}

/**
 * Variables that give a child process AWS access. The drift checks (npm ci, contract:drift) need none, so they run without them: a postinstall script of a tree being
 * checked, or a bug in one, then cannot use the build role. Set to undefined = removed from the child's environment by the exec port.
 */
export const NO_AWS_ENV: Record<string, undefined> = Object.fromEntries([
  "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN", "AWS_CREDENTIAL_EXPIRATION",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_ROLE_SESSION_NAME", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE", "AWS_BEARER_TOKEN_BEDROCK",
].map((name) => [name, undefined]));
