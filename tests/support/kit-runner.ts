// The runner the tests build with. Where this computer has an operating system sandbox it is the real runner; where it has none (a Linux CI image without bubblewrap) the tests that
// are not about the sandbox itself use the same process start WITHOUT one, which exists only here and in `runKitProcess`'s own tests: the commands never use it.
import { createNodeSynthRunner, nodeSynthRunner, planSandbox, runKitProcess, systemSandboxEnvironment, type SynthRunner } from "../../packages/cli/src/upgrade/bundle/synth-run.js";

export const sandboxAvailable = planSandbox({ entry: "/x.mjs", kitDir: "/k", contextFile: "/c", outDir: "/o", workDir: "/w" }, systemSandboxEnvironment()) !== undefined;
/** Runs the kit with NO sandbox: a positive control for the probe tests, and the stand-in where none is installed. */
export const unsandboxedRunner: SynthRunner = { confined: false, sandbox: "none (test only)", run: (input) => runKitProcess(input, undefined) };
export const testRunner: SynthRunner = sandboxAvailable ? nodeSynthRunner : unsandboxedRunner;
export { createNodeSynthRunner, nodeSynthRunner };
