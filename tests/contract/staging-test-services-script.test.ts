// Test services slice 1: scripts/staging-test-services-e2e.sh (written, not run against staging). Its SSM commands carry quotes and braces ("{{.Names}}"), so they are sent as JSON parameters from a file; this test runs the
// script against a FAKE staging guard that records every parameter file it is given, and checks each one parses, holds exactly one command string, and still has the Go template intact.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = new URL("../../scripts/staging-test-services-e2e.sh", import.meta.url).pathname;

describe("the staging done-check script's SSM commands", () => {
  it("never uses the commands=[...] shorthand (quotes and braces in a command break its parser)", () => {
    const text = readFileSync(SCRIPT, "utf8").split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    expect(text).not.toMatch(/commands=\[/u);
    expect(text).toContain('--parameters "file://$params"');
  });

  it("sends parameters that parse as JSON with the Go templates intact, for P4, step 4 and step 7 (the guard is faked)", () => {
    const directory = mkdtempSync(join(tmpdir(), "tse-script-"));
    const recorded = join(directory, "recorded");
    spawnSync("mkdir", ["-p", recorded]);
    const guard = join(directory, "staging-aws.sh");
    writeFileSync(guard, [
      "#!/bin/bash",
      'args="$*"',
      'case "$args" in',
      '  *"ssm send-command"*) for a in "$@"; do case "$a" in file://*) n=$(ls "' + recorded + '" | wc -l | tr -d " "); cp "${a#file://}" "' + recorded + '/params-$n.json" ;; esac; done; echo cmd-1 ;;',
      '  *"get-command-invocation"*"--query Status"*) echo Success ;;',
      '  *"get-command-invocation"*"StandardOutputContent"*) printf "START\\nrovara-catalog/staging/svc/postgres@sha256:abc\\nRUNDIR\\nEND\\n" ;;',
      "  *) echo 944937319445 ;;",
      "esac",
    ].join("\n"));
    chmodSync(guard, 0o755);
    const token = join(directory, "token");
    writeFileSync(token, "not-a-real-token");
    chmodSync(token, 0o600);
    // `sleep` is faked so the polling does not wait.
    const bin = join(directory, "bin");
    spawnSync("mkdir", ["-p", bin]);
    writeFileSync(join(bin, "sleep"), "#!/bin/bash\nexit 0\n");
    chmodSync(join(bin, "sleep"), 0o755);
    const ran = spawnSync("/bin/bash", [SCRIPT, "--only", "P4,4,7", "--worker", "i-0123456789abcdef0", "--task", "task-1"], {
      encoding: "utf8", timeout: 60_000,
      env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOME: directory, TMPDIR: directory, STAGING_AWS: guard, STAGING_E2E_OWNER_GO: "yes", ROVARA_STAGING_URL: "https://staging.example.test", ROVARA_STAGING_TOKEN_FILE: token, ROVARA_STAGING_PROJECT: "sample" },
    });
    const files = readdirSync(recorded).sort();
    expect(files.length, ran.stdout + ran.stderr).toBe(3);
    const commands = files.map((file) => {
      const parsed = JSON.parse(readFileSync(join(recorded, file), "utf8")) as { commands?: unknown };
      expect(Array.isArray(parsed.commands)).toBe(true);
      expect((parsed.commands as unknown[]).length).toBe(1);
      expect(typeof (parsed.commands as unknown[])[0]).toBe("string");
      return (parsed.commands as string[])[0]!;
    });
    expect(commands.some((command) => command.includes('--format "{{.Names}}"'))).toBe(true);
    expect(commands.some((command) => command.includes('--format "{{.Repository}}@{{.Digest}}"'))).toBe(true);
    expect(commands.every((command) => command.includes("START") && command.includes("END"))).toBe(true);
    // The three checks ran to a verdict (not a "did not complete" failure of the plumbing).
    expect(ran.stdout).not.toContain("did not complete");
  });
});
