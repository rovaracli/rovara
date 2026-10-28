import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll } from "vitest";
import { removeCdkAssemblies } from "./cdk-assemblies.js";
import { TEST_TMP_PREFIX } from "./test-temp-dir.js";

/**
 * Vitest setup file, run before every test file: gives the file its own temporary directory inside the run's
 * (tests/support/test-temp-dir.ts) and, when the file ends, removes the cdk.out* assemblies it left there.
 *
 * Every Template.fromStack / app.synth of an App built without an outdir writes a whole cloud assembly under
 * os.tmpdir(), and a stack with a Lambda layer or a bucket deployment copies the 22 MB awscli layer.zip into it. The run's
 * directory is removed only at teardown, so across a CI shard the assemblies filled the runner's disk (EDQUOT, errno -122,
 * on a copyfile). Workers share the run's directory, so one worker may not delete a cdk.out* in it (another worker's synth
 * may be mid-flight); a directory per file makes every cdk.out* in it this file's own.
 *
 * Only entries named cdk.out* inside the file's own directory are removed. Anything else the file left stays until the run's teardown.
 */
const runDirectory = tmpdir();
if (basename(runDirectory).startsWith(TEST_TMP_PREFIX)) {
  const fileDirectory = mkdtempSync(join(runDirectory, "f"));
  process.env.TMPDIR = fileDirectory;
  afterAll(() => {
    removeCdkAssemblies(fileDirectory);
    try {
      rmdirSync(fileDirectory);
    } catch {
      // The file left other things in it; the run's teardown removes them.
    }
    process.env.TMPDIR = runDirectory;
  });
}
