// The rollback record (L2-STAGE-CLI-INTERFACE.md 5): what was live in an environment BEFORE this run, captured in its preflight.
import { stackName } from "../config.ts";
import type { PipelineConfig } from "../config.ts";
import type { PipelineEnv, Ports, RollbackRecord, StackPart } from "../types.ts";
import type { Inputs } from "./context.ts";
import { liveGatewayCodeSha, tagOfSha } from "./refs.ts";

export async function captureRollbackRecord(ports: Ports, config: PipelineConfig, env: PipelineEnv, inputs: Inputs, liveSha: string | null): Promise<RollbackRecord> {
  const stacks: RollbackRecord["stacks"] = {};
  let digest: string | null = null;
  let codeSha: string | null = null;
  for (const part of ["gateway", "web", "app"] as StackPart[]) {
    const name = stackName(config, env, part);
    const described = await ports.cfn.describeStack(name);
    if (described === null) { stacks[part] = { status: "ABSENT", templateSha256: null }; continue; }
    stacks[part] = { status: described.status, templateSha256: await ports.cfn.liveTemplateSha256(name) };
    if (part === "gateway") {
      digest = described.parameters.ImageDigest ?? null;
      codeSha = liveGatewayCodeSha(described.outputs);
    }
  }
  return {
    schema: 1,
    env,
    capturedAt: ports.clock.now().toISOString(),
    executionId: inputs.execId,
    cloud: { tag: liveSha === null ? null : await tagOfSha(ports, config, liveSha), sha: liveSha },
    gateway: { digest, codeSha },
    stacks,
    code: { liveSha: inputs.codeLiveSha, facts: inputs.codeLiveFacts },
  };
}
