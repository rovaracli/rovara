// Gate 2a (L5; BETA-CLOUD-PLAN section 2): after the gateway step, the live gateway serves run prices the Code that will be live can use.
// Ports what Code's own release-order guard asserts (Code packages/cli deploy/gateway-price-preflight.ts assertGatewayRunPrices): GET <gateway>/healthz answers 200 with
// runPrice.version equal to the Code's ModelRunPriceVersion (never below 1), admissionVersion 1 and a positive whole snapshotVersion. The staging pack's fixed snapshot floor is
// NOT ported: the snapshot counter is per environment (beta 4, production 6, staging 11), Code's rule is "a snapshot exists", and a floor would be a made-up number.
// The gateway host is the web stack's own live ModelGatewayUrl parameter (never a name in this file). Read-only: one public GET per try.
import { stackName } from "../config.ts";
import { ATTEMPTS, WAIT_MS } from "../lib/gate-poll.ts";
import { CODE_REPO_ENV, codeShaThatWillBeLive, commitInRepo, envValue } from "../lib/gate-env.ts";
import type { Gate, GateInput } from "../types.ts";

const BASELINE_RUN_PRICE_VERSION = 1;
const HOST = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/u;

/** The ModelRunPriceVersion the Code at `sha` publishes, from its control plane source. Null with a note when it cannot be read; the caller then uses the baseline. */
async function requiredVersion(input: GateInput, notes: string[]): Promise<number> {
  const code = codeShaThatWillBeLive(input.manifest, input.env);
  const repo = await envValue(input.ports, CODE_REPO_ENV);
  if (code.sha === null || repo === null || !await commitInRepo(input.ports, repo, code.sha)) {
    notes.push(`the Code commit or clone is not available (${code.sha === null ? code.why : `${CODE_REPO_ENV} / commit`}): requiring the baseline run-price version ${BASELINE_RUN_PRICE_VERSION}`);
    return BASELINE_RUN_PRICE_VERSION;
  }
  const source = await input.ports.exec("git", ["-C", repo, "show", `${code.sha}:infra/lib/control-plane.ts`]);
  const found = source.code === 0 ? /"ModelRunPriceVersion",\s*\{\s*value:\s*"([0-9]+)"/u.exec(source.stdout) : null;
  if (found === null) {
    notes.push(`Code ${code.sha.slice(0, 9)} publishes no ModelRunPriceVersion: requiring the baseline run-price version ${BASELINE_RUN_PRICE_VERSION}`);
    return BASELINE_RUN_PRICE_VERSION;
  }
  const version = Math.max(BASELINE_RUN_PRICE_VERSION, Number(found[1]));
  notes.push(`Code ${code.sha.slice(0, 9)} publishes ModelRunPriceVersion ${found[1]}: the gateway must serve run-price version ${version}`);
  return version;
}

export function judgeHealthz(status: number, body: string | undefined, required: number): string | null {
  if (status !== 200) return `/healthz answered ${status === 0 ? "nothing (connection failed)" : status}`;
  let doc: { ok?: unknown; runPrice?: { version?: unknown; admissionVersion?: unknown; snapshotVersion?: unknown } } | null;
  try { doc = JSON.parse(body ?? "") as typeof doc; } catch { return "/healthz did not answer JSON"; }
  if (doc === null || typeof doc !== "object" || doc.ok !== true) return "/healthz does not say ok";
  const price = doc.runPrice;
  if (price === undefined || price === null) return "the gateway serves no runPrice section: it is an older gateway than this Code needs";
  if (price.version !== required) return `runPrice.version is ${String(price.version)}, this Code needs ${required}`;
  if (price.admissionVersion !== 1) return `runPrice.admissionVersion is ${String(price.admissionVersion)}, not 1`;
  if (typeof price.snapshotVersion !== "number" || !Number.isSafeInteger(price.snapshotVersion) || price.snapshotVersion <= 0) return "runPrice.snapshotVersion is not a positive whole number (no price snapshot yet)";
  return null;
}

export const gate: Gate = {
  name: "gateway-runprice",
  phases: ["gateway-live"],
  async run(input) {
    const { ports } = input;
    const web = await ports.cfn.describeStack(stackName(input.config, input.env, "web"));
    const base = web?.parameters.ModelGatewayUrl ?? "";
    if (!HOST.test(base)) return { result: "fail", failures: [`the ${input.env} web stack names no usable gateway address (ModelGatewayUrl is ${base === "" ? "empty or the stack is missing" : "not an https origin"})`] };
    const notes: string[] = [];
    const required = await requiredVersion(input, notes);
    let problem: string | null = "not tried";
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const answer = await ports.http.get(`${base}/healthz`, 10_000).catch((): { status: number; body?: string } => ({ status: 0 }));
      problem = judgeHealthz(answer.status, answer.body, required);
      if (problem === null) {
        const snapshot = (JSON.parse(answer.body ?? "{}") as { runPrice: { snapshotVersion: unknown } }).runPrice.snapshotVersion;
        input.log(`try ${attempt}: healthz ok, run-price v${required}, snapshot ${String(snapshot)}`);
        return { result: "pass", notes, data: { requiredVersion: required, snapshotVersion: snapshot, attempts: attempt } };
      }
      input.log(`try ${attempt}/${ATTEMPTS}: ${problem}`);
      if (attempt < ATTEMPTS) await ports.clock.sleep(WAIT_MS);
    }
    return { result: "fail", failures: [`the gateway does not serve run prices this Code can use after ${ATTEMPTS} tries: ${problem}`], notes };
  },
};
