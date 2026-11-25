// Gate 2b (L5): the gateway is SETTLED on the digest the pipeline deployed (the staging pack's gate-gateway-deployed.sh, ported). /healthz alone also passes on the old image,
// so this reads ECS: one deployment, rollout COMPLETED, running == desired (and at least one), and the task definition's image is pinned `@sha256:<64 hex>`, equal to
// the manifest's gateway digest. The service comes from the gateway stack's `ServiceArn` output (written with DeployedCloudSha); a stack without it (nothing deployed it yet)
// is read with cloudformation list-stack-resources instead, and the verdict says which. Read-only. AWS actions: cloudformation:DescribeStacks (+ ListStackResources for
// the fallback), ecs:DescribeServices, ecs:DescribeTaskDefinition.
import { stackName } from "../config.ts";
import { ATTEMPTS, WAIT_MS } from "../lib/gate-poll.ts";
import type { Gate, GateInput } from "../types.ts";

const SERVICE_ARN = /^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:service\/([^/]+)\/([^/]+)$/u;
const PINNED = /@(sha256:[0-9a-f]{64})$/u;

async function serviceArn(input: GateInput, stack: string): Promise<{ arn: string; source: string } | string> {
  const described = await input.ports.cfn.describeStack(stack);
  if (described === null) return `the gateway stack ${stack} does not exist`;
  const output = described.outputs.ServiceArn;
  if (output !== undefined) return SERVICE_ARN.test(output) ? { arn: output, source: "stack output" } : "the ServiceArn output is not an ECS service ARN";
  const listed = await input.ports.aws.json(["cloudformation", "list-stack-resources", "--stack-name", stack]).catch((error: unknown) => error);
  if (listed instanceof Error) return `the stack has no ServiceArn output and listing its resources failed: ${listed.message}`;
  const summaries = (listed as { StackResourceSummaries?: Array<{ ResourceType?: string; PhysicalResourceId?: string }> } | null)?.StackResourceSummaries ?? [];
  const services = summaries.filter((s) => s.ResourceType === "AWS::ECS::Service").map((s) => s.PhysicalResourceId ?? "");
  if (services.length !== 1 || !SERVICE_ARN.test(services[0]!)) return `the stack has no ServiceArn output and ${services.length} ECS service resource(s) in its listing`;
  return { arn: services[0]!, source: "stack resources" };
}

interface Service { runningCount?: number; desiredCount?: number; deployments?: Array<{ rolloutState?: string; taskDefinition?: string }> }

async function judge(input: GateInput, cluster: string, arn: string, expected: string): Promise<{ problem: string | null; digest?: string }> {
  const answer = (await input.ports.aws.json(["ecs", "describe-services", "--cluster", cluster, "--services", arn])) as { services?: Service[] } | null;
  const service = answer?.services?.[0];
  if (service === undefined) return { problem: "ECS does not know the gateway service" };
  const deployments = service.deployments ?? [];
  const summary = `running ${String(service.runningCount)} of ${String(service.desiredCount)}, ${deployments.length} deployment(s), rollout ${deployments[0]?.rolloutState ?? "none"}`;
  if (deployments.length !== 1 || deployments[0]!.rolloutState !== "COMPLETED") return { problem: `not settled: ${summary}` };
  if (typeof service.desiredCount !== "number" || service.desiredCount < 1 || service.runningCount !== service.desiredCount) return { problem: `not settled: ${summary}` };
  const taskDefinition = deployments[0]!.taskDefinition ?? "";
  const definition = (await input.ports.aws.json(["ecs", "describe-task-definition", "--task-definition", taskDefinition])) as { taskDefinition?: { containerDefinitions?: Array<{ image?: string }> } } | null;
  const image = definition?.taskDefinition?.containerDefinitions?.[0]?.image ?? "";
  const pinned = PINNED.exec(image);
  if (pinned === null) return { problem: "the task definition's image is not pinned by digest" };
  if (pinned[1] !== expected) return { problem: `the service runs ${pinned[1]!.slice(0, 19)}..., not the deployed digest ${expected.slice(0, 19)}...` };
  return { problem: null, digest: pinned[1] };
}

export const gate: Gate = {
  name: "gateway-settled",
  phases: ["gateway-live"],
  async run(input) {
    // No digest to compare with = no proof of WHICH image settled. A pin alone also passes the old image, so this fails closed.
    if (input.manifest.gateway.digest === null) return { result: "fail", failures: ["the manifest has no gateway digest, so the gate cannot tell whether the deployed image is the one that settled"] };
    const stack = stackName(input.config, input.env, "gateway");
    const found = await serviceArn(input, stack);
    if (typeof found === "string") return { result: "fail", failures: [found] };
    const cluster = SERVICE_ARN.exec(found.arn)![1]!;
    const expected = input.manifest.gateway.digest;
    const notes = [`service found by ${found.source}`, "checked against the manifest's gateway digest"];
    let problem: string | null = "not tried";
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      let outcome;
      try { outcome = await judge(input, cluster, found.arn, expected); } catch (error) { outcome = { problem: `ECS could not be read: ${error instanceof Error ? error.message : String(error)}` }; }
      problem = outcome.problem;
      if (problem === null) { input.log(`try ${attempt}: settled on ${outcome.digest!.slice(0, 19)}...`); return { result: "pass", notes, data: { digest: outcome.digest, source: found.source, attempts: attempt } }; }
      input.log(`try ${attempt}/${ATTEMPTS}: ${problem}`);
      if (attempt < ATTEMPTS) await input.ports.clock.sleep(WAIT_MS);
    }
    return { result: "fail", failures: [`the gateway is not settled on a digest-pinned image after ${ATTEMPTS} tries: ${problem}`], notes };
  },
};
