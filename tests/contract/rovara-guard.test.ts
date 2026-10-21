// The guard module that every inference request passes through (Plan 3 Task 25; docs/learnings/model-sources-spike.md, questions 8 and 9).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROVARA_GUARD_PY } from "../../packages/model-proxy/src/rovara-guard.js";

describe("rovara_guard.py", () => {
  it("is the module the spike verified, byte for byte (update both together when LiteLLM or Pi is bumped)", () => {
    expect(ROVARA_GUARD_PY).toBe(readFileSync(new URL("../../docs/learnings/model-sources-spike/rovara_guard.py", import.meta.url), "utf8"));
  });

  it("forces every httpx send to stop at a redirect, refuses to start if one would be followed, and allow-lists the three inference routes", () => {
    expect(ROVARA_GUARD_PY).toContain('kwargs["follow_redirects"] = False');
    expect(ROVARA_GUARD_PY).toContain("os._exit(70)");
    for (const route of ["anthropic_messages", "aresponses", "acompletion"]) expect(ROVARA_GUARD_PY).toContain(`"${route}"`);
    for (const refused of ["fallbacks", "router_settings_override", "x-litellm-"]) expect(ROVARA_GUARD_PY).toContain(refused);
    expect(ROVARA_GUARD_PY).toContain("proxy_handler_instance = RovaraGuard()");
  });

  it("carries no key, and is valid Python", () => {
    expect(ROVARA_GUARD_PY).not.toMatch(/sk-[A-Za-z0-9]|AKIA[0-9A-Z]{8}/);
    const directory = mkdtempSync(join(tmpdir(), "rovara-guard-"));
    const file = join(directory, "rovara_guard.py");
    writeFileSync(file, ROVARA_GUARD_PY);
    try {
      execFileSync("python3", ["-I", "-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", file], { stdio: "pipe" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  });
});
