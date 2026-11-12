// Customer test AWS account, lane TA2 (customer-test-account.md, "Auto-detection (read-only)"): what Rovara works out so the admin types nothing. Every function is pure except `suggestExisting`, whose only side effect is one
// list call per service through the port. What comes out is a SUGGESTION: nothing here grants anything (reads of existing resources are allowed by an admin, TA4).
//   - the alias, from `iam:ListAccountAliases`, cleaned (it is the customer's text: it is shown in a page and goes in an audit detail);
//   - the Region, read from the repo's own deployment config (CDK `env`, Terraform provider, SAM and serverless config); several different Regions means ambiguous, and nothing is preselected;
//   - the existing resources a repo's IaC names (`Table.fromTableName`, Terraform `data`), matched against names that actually exist in the account: only matches are suggested;
//   - whether the account looks like production: an alias that says so needs the admin's "this is not production" tick.
// Repo text is untrusted input: file count, file size and match count are bounded, and a name must be a plain resource name.
import type { AccountCalls } from "./aws-port.js";

const REGION = "[a-z]{2}(?:-[a-z]+)+-\\d";
export const DETECT_MAX_FILES = 200;
export const DETECT_MAX_FILE_CHARS = 256 * 1024;
export const DETECT_MAX_REFERENCES = 200;
const RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;

export interface RepoFile { path: string; text: string }

const bounded = (files: readonly RepoFile[]): RepoFile[] => files.slice(0, DETECT_MAX_FILES).map((file) => ({ path: file.path, text: file.text.slice(0, DETECT_MAX_FILE_CHARS) }));

/**
 * The Regions a repo's deployment config names, from `region: us-west-2`, `region = "us-west-2"`, `"region": "us-west-2"` and `region: 'us-west-2'` in CDK, Terraform, SAM and serverless files. `supported` limits the answer to
 * the Regions Rovara has a topic in. One Region is the answer; more than one is `ambiguous` and none is preselected; none is `undefined` (the stack's own Region is used).
 */
export function detectRegion(files: readonly RepoFile[], supported: readonly string[]): { region: string | undefined; candidates: string[]; ambiguous: boolean } {
  const found = new Set<string>();
  const pattern = new RegExp(`\\bregion["']?\\s*[:=]\\s*["']?(${REGION})["']?`, "gu");
  for (const file of bounded(files)) {
    for (const line of file.text.split(/\r?\n/u)) {
      if (/^\s*(?:#|\/\/|\*)/u.test(line)) continue;
      for (const match of line.matchAll(pattern)) {
        const region = match[1] as string;
        if (supported.includes(region)) found.add(region);
      }
    }
  }
  const candidates = [...found].sort();
  return { region: candidates.length === 1 ? candidates[0] : undefined, candidates, ambiguous: candidates.length > 1 };
}

export type SuggestableService = "dynamodb" | "s3" | "sqs" | "sns";
export interface ExistingReference { service: SuggestableService; name: string }

const CDK_REFERENCES: ReadonlyArray<[SuggestableService, RegExp]> = [
  ["dynamodb", /\bfromTableName\s*\(\s*[^,()]+,\s*[^,()]+,\s*["']([^"']+)["']/gu],
  ["s3", /\bfromBucketName\s*\(\s*[^,()]+,\s*[^,()]+,\s*["']([^"']+)["']/gu],
  ["sqs", /\bfromQueueName\s*\(\s*[^,()]+,\s*[^,()]+,\s*["']([^"']+)["']/gu],
  ["sns", /\bfromTopicName\s*\(\s*[^,()]+,\s*[^,()]+,\s*["']([^"']+)["']/gu],
];
const TERRAFORM_DATA: ReadonlyArray<[SuggestableService, string, string]> = [
  ["dynamodb", "aws_dynamodb_table", "name"],
  ["s3", "aws_s3_bucket", "bucket"],
  ["sqs", "aws_sqs_queue", "name"],
  ["sns", "aws_sns_topic", "name"],
];

/** The existing resources a repo's IaC names: CDK `fromTableName`-style lookups and Terraform `data` blocks. Plain names only, deduplicated, at most `DETECT_MAX_REFERENCES`. */
export function referencedNames(files: readonly RepoFile[]): ExistingReference[] {
  const found = new Map<string, ExistingReference>();
  const add = (service: SuggestableService, name: string | undefined): void => {
    if (name === undefined || !RESOURCE_NAME.test(name) || found.size >= DETECT_MAX_REFERENCES) return;
    found.set(`${service}:${name}`, { service, name });
  };
  for (const file of bounded(files)) {
    for (const [service, pattern] of CDK_REFERENCES) for (const match of file.text.matchAll(pattern)) add(service, match[1]);
    for (const [service, type, attribute] of TERRAFORM_DATA) {
      const block = new RegExp(`data\\s+"${type}"\\s+"[^"]+"\\s*\\{([^}]*)\\}`, "gu");
      for (const match of file.text.matchAll(block)) add(service, new RegExp(`\\b${attribute}\\s*=\\s*"([^"]+)"`, "u").exec(match[1] ?? "")?.[1]);
    }
  }
  return [...found.values()].sort((left, right) => `${left.service}:${left.name}`.localeCompare(`${right.service}:${right.name}`));
}

/** One list call per service the repo references; a name is suggested only when the account really has it. A refused list suggests nothing for that service. */
export async function suggestExisting(calls: Pick<AccountCalls, "listNames">, references: readonly ExistingReference[]): Promise<ExistingReference[]> {
  const suggested: ExistingReference[] = [];
  for (const service of [...new Set(references.map((reference) => reference.service))]) {
    const names = await calls.listNames(service, 1_000);
    if (names === undefined) continue;
    const present = new Set(names);
    for (const reference of references) if (reference.service === service && present.has(reference.name)) suggested.push(reference);
  }
  return suggested;
}

/** An alias as it is kept and shown: the customer's text, cut to what AWS allows (3 to 63 of `a-z0-9-`), anything else dropped. Undefined when nothing usable is left. */
export function sanitizeAlias(alias: string | undefined): string | undefined {
  if (alias === undefined) return undefined;
  const cleaned = alias.toLowerCase().replace(/[^a-z0-9-]/gu, "").slice(0, 63);
  return cleaned.length >= 3 ? cleaned : undefined;
}

/** An alias that says production: `prod`, `production` or `prd` as a whole word of the alias. */
export function isProdAlias(alias: string | undefined): boolean {
  return alias !== undefined && /(?:^|-)(?:prod|production|prd)(?:-|$)/u.test(alias);
}
