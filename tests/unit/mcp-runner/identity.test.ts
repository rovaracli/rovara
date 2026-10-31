// Stdio MCP host redesign, fix round 1 (m2): a runner program refuses to run as root by any of the four ids, group 0 included.
import { describe, expect, it } from "vitest";
import { runsAsRoot } from "../../../packages/gateway/src/mcp-runner/identity.js";

const ok = { getuid: () => 10_003, geteuid: () => 10_003, getgid: () => 10_003, getegid: () => 10_003 };

describe("runsAsRoot", () => {
  it("is false for a non-root user and group", () => {
    expect(runsAsRoot(ok)).toBe(false);
  });
  it("is true when any one of uid, euid, gid or egid is 0", () => {
    for (const key of ["getuid", "geteuid", "getgid", "getegid"] as const) expect(runsAsRoot({ ...ok, [key]: () => 0 }), key).toBe(true);
  });
  it("is false where an id does not exist (a platform with no ids)", () => {
    expect(runsAsRoot({ getuid: () => undefined, geteuid: () => undefined, getgid: () => undefined, getegid: () => undefined })).toBe(false);
  });
  it("reads this process's own ids when none are given (a test machine is not root)", () => {
    expect(runsAsRoot()).toBe(process.getuid?.() === 0 || process.getgid?.() === 0 || process.geteuid?.() === 0 || process.getegid?.() === 0);
  });
});
