// Stdio MCP host redesign, fix round 1 (I4): the scope of a runner task's token. The server container can read its own token, so the token must be worth nothing but its own bundle.
import { describe, expect, it } from "vitest";
import { RUNNER_TOKEN_MIN_LENGTH, generateRunnerToken, runnerTokenAllows, runnerTokenWellFormed } from "../../../packages/gateway/src/mcp-runner/token-scope.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("runner token scope", () => {
  it("makes 256-bit tokens that differ every time", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateRunnerToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) { expect(token).toHaveLength(RUNNER_TOKEN_MIN_LENGTH); expect(runnerTokenWellFormed(token)).toBe(true); }
  });
  it("calls a token well formed only if it is at least 43 URL-safe characters", () => {
    expect(runnerTokenWellFormed("t".repeat(43))).toBe(true);
    for (const bad of ["t".repeat(42), "", "short", `${"t".repeat(42)} `, `${"t".repeat(42)}+`, `${"t".repeat(42)}\n`, "t".repeat(129), 5, undefined, null]) expect(runnerTokenWellFormed(bad), String(bad)).toBe(false);
  });
  it("lets an install token PUT a bundle and its result and nothing else", () => {
    expect(runnerTokenAllows({ purpose: "install" }, "PUT", `/bundles/${A}`)).toBe(true);
    expect(runnerTokenAllows({ purpose: "install" }, "PUT", "/result")).toBe(true);
    for (const method of ["GET", "POST", "DELETE", "HEAD"]) expect(runnerTokenAllows({ purpose: "install" }, method, "/result"), method).toBe(false);
    for (const purpose of ["fetch", "serve", "probe"] as const) expect(runnerTokenAllows({ purpose, bundleHash: A }, "PUT", "/result"), purpose).toBe(false);
    expect(runnerTokenAllows({ purpose: "install" }, "PUT", "/result/")).toBe(false);
    for (const [method, path] of [["GET", `/bundles/${A}`], ["DELETE", `/bundles/${A}`], ["POST", `/bundles/${A}`], ["PUT", "/bundles/short"], ["PUT", `/bundles/${A}/x`], ["PUT", "/servers/mcpabcdef/mcp"], ["PUT", `/bundles/${A.toUpperCase()}`]] as const) {
      expect(runnerTokenAllows({ purpose: "install" }, method, path), `${method} ${path}`).toBe(false);
    }
  });
  it("lets a fetch, serve or probe token GET only the one bundle its task was approved to run, and never PUT", () => {
    for (const purpose of ["fetch", "serve", "probe"] as const) {
      const scope = { purpose, bundleHash: A };
      expect(runnerTokenAllows(scope, "GET", `/bundles/${A}`)).toBe(true);
      expect(runnerTokenAllows(scope, "GET", `/bundles/${B}`), purpose).toBe(false);
      for (const method of ["PUT", "POST", "DELETE", "HEAD", "PATCH"]) expect(runnerTokenAllows(scope, method, `/bundles/${A}`), `${purpose} ${method}`).toBe(false);
      expect(runnerTokenAllows(scope, "GET", "/healthz")).toBe(false);
      expect(runnerTokenAllows(scope, "GET", `/bundles/${A}/`)).toBe(false);
    }
  });
  it("refuses everything for a scope whose bundle hash is not a sha256", () => {
    expect(runnerTokenAllows({ purpose: "serve", bundleHash: "x" }, "GET", "/bundles/x")).toBe(false);
    expect(runnerTokenAllows({ purpose: "serve", bundleHash: "" }, "GET", "/bundles/")).toBe(false);
  });
});
