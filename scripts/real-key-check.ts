// OWNER-RUN ONLY (DEC 254t a): ONE real, billed call with the owner's own key, through the gateway's own agent path, before a company AI
// source kind is switched on for an install (-c rovaraAiSourceKinds). Never imported by tests or packages (a test pins that); the tests
// use scripts/real-key-check-lib.ts with fake transports.
//
//   cd <this worktree> && ROVARA_REAL_KEY_CHECK=1 node_modules/.bin/tsx scripts/real-key-check.ts anthropic
//     The key: ROVARA_CHECK_ANTHROPIC_KEY if set (e.g. `read -rs ROVARA_CHECK_ANTHROPIC_KEY; export ROVARA_CHECK_ANTHROPIC_KEY`, then
//     `unset ROVARA_CHECK_ANTHROPIC_KEY` after), otherwise asked for in the terminal without echo. Never an argument, a file or chat.
//     Optional: ROVARA_CHECK_ANTHROPIC_MODEL (default claude-haiku-4-5).
//   cd <this worktree> && ROVARA_REAL_KEY_CHECK=1 ROVARA_CHECK_BEDROCK_REGION=us-west-2 node_modules/.bin/tsx scripts/real-key-check.ts bedrock
//     YOUR OWN AWS account's credentials from the AWS CLI's normal chain (AWS_PROFILE or the default profile), read once with
//     `aws configure export-credentials` and kept in memory. Never through staging-aws.sh (refused). Optional: ROVARA_CHECK_BEDROCK_MODEL
//     (default us.anthropic.claude-haiku-4-5-20251001-v1:0 in a US Region; required elsewhere), ROVARA_CHECK_BEDROCK_AGENT_MODEL (default
//     claude-haiku-4-5).
//
// Cost: one call, one forced tool call, max_tokens 64 (the gateway's guard refuses anything above 256), a prompt under 1 KB: well under
// one cent on any of these models. Prints one line per check and a final PASS or FAIL; exit 0 on PASS, 1 otherwise, 2 when refused.
// Nothing the key touches is printed, logged or written: every failure is fixed words.
import { execFileSync } from "node:child_process";
import { createAnthropicTransport } from "../packages/model-gateway/src/provider.js";
import { createBedrockTransport } from "../packages/model-gateway/src/bedrock-transport.js";
import {
  anthropicModel, bedrockSettings, CHECK_KINDS_BUILT, CONSENT_VARIABLE, formatResult, KEY_VARIABLE, keyProblem, parseCliCredentials, parseKind,
  promptHidden, runCheck, WORDS, type CheckKind, type CheckTarget,
} from "./real-key-check-lib.js";

const say = (text: string) => { process.stdout.write(`${text}\n`); };
const refuse = (text: string): never => { process.stderr.write(`${text}\n`); process.exit(2); };
// Nothing an error carries is ever printed: it could hold a header or a body.
const stop = () => { process.stderr.write(`${WORDS.stopped}\n`); process.exit(1); };
process.on("uncaughtException", stop);
process.on("unhandledRejection", stop);

async function key(kind: CheckKind): Promise<string> {
  const variable = KEY_VARIABLE[kind]!;
  const fromEnv = process.env[variable];
  const value = fromEnv !== undefined && fromEnv !== "" ? fromEnv : await promptHidden(process.stdin, (text) => { process.stderr.write(text); }, `Your ${kind} key`);
  if (value === undefined) return refuse(WORDS.noKey);
  const problem = keyProblem(value);
  if (problem !== undefined) return refuse(problem);
  return value;
}

async function target(kind: CheckKind): Promise<CheckTarget> {
  if (kind === "anthropic") {
    const model = anthropicModel(process.env);
    if (model === undefined) return refuse(WORDS.badModel);
    return { kind, key: await key(kind), model, transport: createAnthropicTransport() };
  }
  if (kind === "bedrock") {
    const settings = bedrockSettings(process.env);
    if (typeof settings === "string") return refuse(settings);
    let text: string;
    try { text = execFileSync("aws", ["configure", "export-credentials", "--format", "process"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }); } catch { return refuse(WORDS.noCredentials); }
    const credentials = parseCliCredentials(text);
    if (credentials === undefined) return refuse(WORDS.noCredentials);
    return { kind, ...settings, credentials, transport: (region, source) => createBedrockTransport({ region, credentials: source }) };
  }
  return refuse(WORDS.notBuilt);
}

const kind = parseKind(process.argv.slice(2));
if (kind === undefined) refuse(WORDS.usage);
if (process.env[CONSENT_VARIABLE] !== "1") refuse(WORDS.consent);
if (!CHECK_KINDS_BUILT.includes(kind!)) refuse(WORDS.notBuilt);
try {
  const result = await runCheck(await target(kind!));
  for (const line of formatResult(kind!, result)) say(line);
  process.exit(result.pass ? 0 : 1);
} catch { stop(); }
