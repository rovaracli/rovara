import fs from "node:fs";
import { afterAll } from "vitest";
import { trackCdkAssemblies } from "./cdk-assemblies.js";

/**
 * Vitest setup file, run before every test file: removes the CDK assemblies the file made when it ends.
 *
 * Every Template.fromStack / app.synth of an App built without an outdir writes a whole cloud assembly under
 * os.tmpdir(), and a stack with a Lambda layer or a bucket deployment copies the 22 MB awscli layer.zip into it. The run's
 * directory (tests/support/test-temp-dir.ts) is removed only at teardown, so across a CI shard the assemblies filled the runner's disk
 * (EDQUOT, errno -122, on a copyfile).
 *
 * Workers share that directory, so a cleanup by name could delete another worker's synth in progress. This records the directories this process
 * creates (fs.mkdtempSync on a cdk.out* name) and removes exactly those. It does not move os.tmpdir(): paths under it hold unix sockets, and
 * macOS allows only 104 bytes of socket path, so no directory level may be added to them.
 */
const tracker = trackCdkAssemblies(fs);
// Removing a file's CDK assemblies can take longer than the default 10 s hook limit on a loaded CI runner.
afterAll(() => {
  tracker.finish();
}, 60_000);
