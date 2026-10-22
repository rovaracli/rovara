import { spawnSync } from "node:child_process";
import { describe, expect, it } from "./support/vitest-lite.js";
import { packageFile } from "./support/paths.js";

describe("the package is ready to publish", () => {
  it("holds nothing private, by its own check", () => {
    const result = spawnSync(process.execPath, [packageFile("scripts", "check-public.mjs"), packageFile()], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
