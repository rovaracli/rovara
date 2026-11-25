// Tests that run the real gitleaks (tests/contract/pipeline-gitleaks-bypass.test.ts) must never skip silently where the secret scan is the point.
// In CI (GitHub Actions sets CI=true) a missing gitleaks is a FAILED test; on a developer machine the tests are skipped, with a loud note on stderr.
import { spawnSync } from "node:child_process";

export type GitleaksPlan = "run" | "skip" | "fail";

/** True when the environment says this is a CI run. */
export function inCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const flag = (value: string | undefined): boolean => value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
  return flag(env.CI) || flag(env.GITHUB_ACTIONS);
}

export function gitleaksPlan(haveGitleaks: boolean, env: Readonly<Record<string, string | undefined>>): GitleaksPlan {
  if (haveGitleaks) return "run";
  return inCi(env) ? "fail" : "skip";
}

export const GITLEAKS_MISSING_IN_CI = "gitleaks is not on PATH in CI: the real-gitleaks tests of the secret-scan gate must run there (install the pinned gitleaks in the CI job, see .github/workflows/ci.yml)";
export const GITLEAKS_MISSING_LOCALLY = "gitleaks is not on PATH: the real-gitleaks tests of the secret-scan gate are SKIPPED here (CI fails without it); install gitleaks 8.30.1 to run them";

/** Probes PATH once; prints the loud note on stderr when the tests will be skipped locally. */
export function gitleaksPlanNow(env: Readonly<Record<string, string | undefined>> = process.env): GitleaksPlan {
  const plan = gitleaksPlan(spawnSync("gitleaks", ["version"]).status === 0, env);
  if (plan === "skip") process.stderr.write(`\n!!! ${GITLEAKS_MISSING_LOCALLY}\n\n`);
  return plan;
}
