// Gate (L6): the gateway stack's live ImageDigest parameter equals the manifest's digest (the digest beta ran; production copied exactly it).
// A second check behind the image step's own assert: it reads what the stack really runs after the deploy, not what the step returned.
import { stackName } from "../config.ts";
import { IMAGE_DIGEST } from "../lib/ecr.ts";
import type { Gate } from "../types.ts";

export const gate: Gate = {
  name: "gateway-digest-equal",
  phases: ["proof"],
  async run(input) {
    // A dry run builds and copies nothing, so there is no digest to compare: never a pass (a pass must not move last-good).
    if (input.dryRun === true) return { result: "skipped", skippedReason: "dry run: no image built" };
    const want = input.manifest.gateway.digest;
    if (want === null || !IMAGE_DIGEST.test(want)) return { result: "fail", failures: ["the manifest holds no gateway digest to compare the live stack with"] };
    const stack = stackName(input.config, input.env, "gateway");
    const live = await input.ports.cfn.describeStack(stack);
    if (live === null) return { result: "fail", failures: [`the stack ${stack} does not exist`] };
    const have = live.parameters.ImageDigest;
    if (have === undefined) return { result: "fail", failures: [`the stack ${stack} has no ImageDigest parameter`] };
    if (have !== want) return { result: "fail", failures: [`${stack} runs ${have} but this execution's gateway digest is ${want}`], data: { live: have, expected: want } };
    input.log(`${stack} ImageDigest equals the manifest digest (${want.slice(0, 19)}...), stack ${live.status}`);
    return { result: "pass", data: { digest: want, stackStatus: live.status } };
  },
};
