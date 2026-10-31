// The broker's source as one text, for the tests that pin what the code says (a call that must be present, an order of two calls, a function's body). packages/broker/src/aws/broker.ts
// was split into broker.ts and the modules in packages/broker/src/aws/broker/ (scripts/split/split-broker.ts); the modules come first, in the order the one file had them, then broker.ts
// (the part that builds the Lambda's clients and the handler, which was at the end).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = "packages/broker/src/aws/broker";
const SOURCE = "packages/broker/src/aws/broker.ts";
/** The modules in the order the original file had their parts (written by the split; a module file not listed comes after them, by name). */
const ORDER = ["definitions","scope-helpers","dependency-wiring","handler","workspace-routes","project-registration","workspace-preparation","thread-workspaces","task-operations","model-access","acceptance","slack-workflow-events","callbacks","evidence-and-setup","workflow-e2e-verification","feedback-and-codebuild","pull-request-reconcile","terminal-and-github-events","sweeps-and-readiness","dispatch","e2e-rounds","workflow-items","plan-answers","terminal-result","records","admin-and-helpers","runtime-clients"];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The broker's source files (paths from the repository root) in the order the original single file had their parts. */
export function brokerSourceFiles(): string[] {
  const folder = path.join(ROOT, OUT_DIR);
  const present = new Set(readdirSync(folder).filter((name) => name.endsWith(".ts")));
  const ordered = ORDER.map((name) => `${name}.ts`).filter((name) => present.delete(name));
  const rest = [...present].sort();
  return [...[...ordered, ...rest].map((name) => `${OUT_DIR}/${name}`), SOURCE];
}

/** All of it, as one string. */
export function readBrokerSource(): string {
  return brokerSourceFiles().map((file) => readFileSync(path.join(ROOT, file), "utf8")).join("\n");
}
