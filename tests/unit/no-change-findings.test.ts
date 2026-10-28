// A coding run that ends with no code change keeps what it found: the commands the agent ran, their output and its own conclusion. This is the shape, its bounds and its redaction
// (the worker builds it before it leaves; the broker rebuilds whatever arrives before it is stored or shown).
import { describe, expect, it } from "vitest";
import {
  NO_CHANGE_FINDINGS_COMMANDS_MAX, NO_CHANGE_FINDINGS_COMMAND_MAX, NO_CHANGE_FINDINGS_CONCLUSION_MAX, NO_CHANGE_FINDINGS_OUTPUT_MAX, NO_CHANGE_FINDINGS_TOTAL_MAX,
  NO_CODE_CHANGED_LEGACY_REASONS, NO_CODE_CHANGED_REASON, NoChangeFindingsSchema, buildNoChangeFindings, isNoCodeChangedReason, noChangeFindingsFrom, noChangeFindingsSize,
  NO_CHANGE_FINDINGS_OMITTED_MAX, NO_CHANGE_OUTPUT_HIDDEN, NO_CHANGE_VALUE_HIDDEN, commandReadsSecrets, maskSecretValues, isSecretName, noChangeHasThread,
} from "../../packages/contracts/src/no-change-findings.js";
import { FindingsRecorder } from "../../packages/worker/src/no-change-findings.js";
import { WORKFLOW_BLOCK_REASONS } from "../../packages/contracts/src/task-workflow.js";
import { WorkflowSnapshotSchema, blockWorkflow, createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";

// Built at run time: no key-shaped literal is in this file.
const secret = (): string => ["ghp_", "Ab12".repeat(9)].join("");
const awsKey = (): string => ["AKIA", "QWERTYUIOPASDFGH"].join("");

describe("buildNoChangeFindings", () => {
  it("keeps the commands, their output and the conclusion as the agent left them", () => {
    const findings = buildNoChangeFindings({ commands: [{ command: "grep -rn retry src", output: "src/a.ts:4: retry\n" }, { command: "npm test", output: "3 passed", failed: false }], conclusion: "We do use retry, in src/a.ts." });
    expect(findings).toEqual({ commands: [{ command: "grep -rn retry src", output: "src/a.ts:4: retry" }, { command: "npm test", output: "3 passed" }], conclusion: "We do use retry, in src/a.ts." });
    expect(NoChangeFindingsSchema.safeParse(findings).success).toBe(true);
  });

  it("caps everything: many commands, huge outputs and a huge conclusion stay under the fixed limits, and the last commands are the ones kept", () => {
    const commands = Array.from({ length: 40 }, (_, index) => ({ command: `run-${String(index)} ${"x".repeat(1000)}`, output: `out-${String(index)} ${"y".repeat(50_000)}` }));
    const findings = buildNoChangeFindings({ commands, conclusion: "z".repeat(30_000) });
    expect(findings.commands).toHaveLength(NO_CHANGE_FINDINGS_COMMANDS_MAX);
    expect(findings.omitted).toBe(30);
    expect(findings.commands[0]!.command.startsWith("run-30 ")).toBe(true);
    expect(findings.commands.at(-1)!.command.startsWith("run-39 ")).toBe(true);
    for (const item of findings.commands) {
      expect(item.command.length).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_COMMAND_MAX);
      expect((item.output ?? "").length).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_OUTPUT_MAX);
    }
    expect(findings.conclusion!.length).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_CONCLUSION_MAX);
    expect(noChangeFindingsSize(findings)).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_TOTAL_MAX);
    expect(NoChangeFindingsSchema.safeParse(findings).success).toBe(true);
  });

  it("keeps the beginning and the end of a long output, so a test run's summary line survives", () => {
    const findings = buildNoChangeFindings({ commands: [{ command: "npm test", output: `START ${"m".repeat(5000)} 12 passed, 0 failed` }] });
    const output = findings.commands[0]!.output!;
    expect(output.startsWith("START")).toBe(true);
    expect(output.endsWith("12 passed, 0 failed")).toBe(true);
    expect(output.length).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_OUTPUT_MAX);
  });

  it("the total limit wins over the per-command limit: the conclusion keeps its room and the earliest outputs shrink first", () => {
    const findings = buildNoChangeFindings({ commands: Array.from({ length: 10 }, (_, index) => ({ command: `c${String(index)}`, output: "o".repeat(NO_CHANGE_FINDINGS_OUTPUT_MAX) })), conclusion: "k".repeat(NO_CHANGE_FINDINGS_CONCLUSION_MAX) });
    expect(noChangeFindingsSize(findings)).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_TOTAL_MAX);
    expect(findings.conclusion).toHaveLength(NO_CHANGE_FINDINGS_CONCLUSION_MAX);
    expect(findings.commands.at(-1)!.output!.length).toBeGreaterThan(0);
  });

  it("redacts a secret in a command, its output and the conclusion (positive control: the plain text did hold it)", () => {
    const token = secret(), key = awsKey();
    const raw = { commands: [{ command: `curl -H "Authorization: Bearer ${token}" https://example.test`, output: `found ${token} and ${key}` }], conclusion: `The key ${key} is in the environment.` };
    expect(JSON.stringify(raw)).toContain(token);
    const text = JSON.stringify(buildNoChangeFindings(raw));
    expect(text).not.toContain(token);
    expect(text).not.toContain(key);
    expect(text).toContain("[REDACTED]");
  });

  it("makes a command one line, drops control characters, and leaves out anything that is not text", () => {
    const findings = buildNoChangeFindings({ commands: [{ command: "echo a\n\techo b\u0007" }, { command: 42 }, { output: "no command" }, null as never, { command: "   " }], conclusion: 7 });
    expect(findings).toEqual({ commands: [{ command: "echo a echo b" }] });
  });

  it("says nothing about a conclusion when the agent wrote none", () => {
    expect(buildNoChangeFindings({ commands: [{ command: "ls" }], conclusion: undefined }).conclusion).toBeUndefined();
    expect(buildNoChangeFindings({ commands: [{ command: "ls" }], conclusion: "  \n " }).conclusion).toBeUndefined();
  });
});

describe("noChangeFindingsFrom: a result's block is rebuilt on this side", () => {
  it("is undefined when there is no block at all (an older worker), and for anything that is not an object", () => {
    for (const raw of [undefined, null, "text", 4, [], [{ commands: [] }]]) expect(noChangeFindingsFrom(raw)).toBeUndefined();
  });

  it("keeps an empty block (a newer worker that saw no commands and no conclusion)", () => {
    expect(noChangeFindingsFrom({ commands: [] })).toEqual({ commands: [] });
  });

  it("redacts and bounds what a worker sent, whatever it sent (a hostile or a newer one)", () => {
    const token = secret();
    const hostile = { commands: Array.from({ length: 200 }, (_, index) => ({ command: `c${String(index)} ${token}`, output: `${token} ${"q".repeat(10_000)}` })), omitted: 7, conclusion: `${token} ${"w".repeat(50_000)}`, extra: "ignored" };
    const findings = noChangeFindingsFrom(hostile)!;
    expect(JSON.stringify(findings)).not.toContain(token);
    expect(findings.commands).toHaveLength(NO_CHANGE_FINDINGS_COMMANDS_MAX);
    expect(findings.omitted).toBe(7 + 190);
    expect(noChangeFindingsSize(findings)).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_TOTAL_MAX);
    expect(NoChangeFindingsSchema.safeParse(findings).success).toBe(true);
    expect(JSON.stringify(findings)).not.toContain("ignored");
  });

  it("survives a malformed block without throwing", () => {
    expect(noChangeFindingsFrom({ commands: "nope", conclusion: { a: 1 }, omitted: "many" })).toEqual({ commands: [] });
    expect(noChangeFindingsFrom({ commands: [1, "two", { command: { deep: true } }] })).toEqual({ commands: [] });
  });
});

describe("the block reason", () => {
  it("is the new wording, and the wording stored before still reads as this stop", () => {
    expect(WORKFLOW_BLOCK_REASONS.noCodeChanged).toBe(NO_CODE_CHANGED_REASON);
    expect(isNoCodeChangedReason(NO_CODE_CHANGED_REASON)).toBe(true);
    for (const legacy of NO_CODE_CHANGED_LEGACY_REASONS) expect(isNoCodeChangedReason(legacy)).toBe(true);
    expect(isNoCodeChangedReason("Coding stopped before it finished.")).toBe(false);
    expect(isNoCodeChangedReason(undefined)).toBe(false);
    expect(NO_CODE_CHANGED_LEGACY_REASONS[0]).toContain("no code changed");
    expect(NO_CODE_CHANGED_REASON).not.toMatch(/verified|checks passed/iu);
  });
});

describe("blocking a coding step keeps findings only for the no-code-change stop", () => {
  const now = "2026-10-26T12:00:00.000Z";
  const plan = { id: "plan-v1", type: "plan" as const, version: 1, sha256: "c".repeat(64), producer: "p", objectKey: "private/o/w/op/plan.md", createdAt: now };
  const coding = () => WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId: "11111111-1111-4111-8111-111111111111", ownerId: "a".repeat(64), now }), revision: 5, stage: "IMPLEMENT", state: "RUNNING", artifacts: [plan] });
  const found = { commands: [{ command: "ls" }], conclusion: "Nothing to change." };

  it("keeps them with the no-code-change reason, and drops an earlier run's when the step is blocked again for another reason", () => {
    const stopped = blockWorkflow(coding(), NO_CODE_CHANGED_REASON, now, { noChangeFindings: found });
    expect(stopped.noChangeFindings).toEqual(found);
    expect(stopped).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: NO_CODE_CHANGED_REASON });
    const again = blockWorkflow({ ...stopped, state: "RUNNING" }, "implementation operation ended failed", now, { noChangeFindings: found });
    expect(again.noChangeFindings).toBeUndefined();
    expect(blockWorkflow({ ...stopped, state: "RUNNING" }, "implementation operation ended failed", now).noChangeFindings).toBeUndefined();
  });

  it("never attaches them to another reason, whatever the caller passed", () => {
    expect(blockWorkflow(coding(), "implementation operation ended failed", now, { noChangeFindings: found }).noChangeFindings).toBeUndefined();
  });
});

// Values built at run time: no key-shaped literal is in this file.
const salt = (): string => ["s4lt", "Zq81".repeat(4)].join("-");
const hmac = (): string => ["h", "9f3a".repeat(8)].join("");
const stripe = (): string => ["rk_", "live_", "Q7w2".repeat(6)].join("");
const dotenv = (): string => `NODE_ENV=production\nSIGNING_SALT=${salt()}\nHMAC=${hmac()}\nSTRIPE_LIVE=${stripe()}\nPORT=3000\n`;

describe("commands that read environment or secret material", () => {
  it("are recognised, however they are written", () => {
    for (const command of [
      "cat .env", "cat .env.production", "cat ./app/.env.local", "env", "env | sort", "FOO=1 env", "printenv", "printenv API_TOKEN", "set", "export -p", "export", "head -n5 server.pem", "tail ~/.ssh/id_rsa",
      "grep -n x credentials.json", "less config/secrets.yml", "cat .npmrc", "cat ~/.netrc", "cat .pypirc", "cat .git-credentials", "cat ~/.kube/kubeconfig", "cat ~/.aws/credentials",
      "cat ~/.docker/config.json", "cd app && cat '.env'", 'cat "$(pwd)/.env"', "cat < .env", "grep KEY --file=.env", "cat /proc/self/environ", "read app/.env", "grep -rn x *.key",
    ]) expect(commandReadsSecrets(command), command).toBe(true);
    for (const command of ["grep -rn retry src", "npm test", "ls src", "env NODE_ENV=test npm test", "export FOO=1", "cat package.json", "read app/a.ts", "git log --oneline"]) expect(commandReadsSecrets(command), command).toBe(false);
  });

  it("keep no output at all: `cat .env` and `env` show only that the output was not shown, in the worker's block and again when the broker rebuilds it", () => {
    const raw = { commands: [{ command: "cat .env", output: dotenv() }, { command: "env", output: dotenv() }, { command: "grep -rn retry src", output: "src/a.ts:4: retry" }] };
    for (const findings of [buildNoChangeFindings(raw), noChangeFindingsFrom(raw)!, noChangeFindingsFrom(buildNoChangeFindings(raw))!]) {
      expect(findings.commands.map((item) => item.output)).toEqual([NO_CHANGE_OUTPUT_HIDDEN, NO_CHANGE_OUTPUT_HIDDEN, "src/a.ts:4: retry"]);
      const text = JSON.stringify(findings);
      for (const value of [salt(), hmac(), stripe()]) expect(text).not.toContain(value);
    }
    // Positive control: the raw block did hold them.
    expect(JSON.stringify(raw)).toContain(salt());
  });

  it("keep no output of a file read: the output of `read` is left out", () => {
    const findings = buildNoChangeFindings({ commands: [{ command: "read app/a.ts", output: "export const x = 1;" }] });
    expect(findings.commands).toEqual([{ command: "read app/a.ts" }]);
  });
});

describe("secret-looking values are hidden", () => {
  it("masks KEY=value and KEY: value where the key looks like a secret's name, keeping the key, in an output and in the conclusion", () => {
    const output = `API_TOKEN=abc123\nmy_password = "two words"\nsession_cookie: deadbeef\n  - private_key: xyz\n"client_secret": "v",\nUSER_AUTH=${stripe()}\nPORT=3000\nNAME: plain`;
    const masked = maskSecretValues(output);
    expect(masked).toBe(`API_TOKEN=${NO_CHANGE_VALUE_HIDDEN}\nmy_password = ${NO_CHANGE_VALUE_HIDDEN}\nsession_cookie: ${NO_CHANGE_VALUE_HIDDEN}\n  - private_key: ${NO_CHANGE_VALUE_HIDDEN}\n"client_secret": ${NO_CHANGE_VALUE_HIDDEN}\nUSER_AUTH=${NO_CHANGE_VALUE_HIDDEN}\nPORT=3000\nNAME: plain`);
    const findings = buildNoChangeFindings({ commands: [{ command: "node dump.js", output: `SIGNING_SALT=${salt()}\nHMAC: ${hmac()}\nOK=1` }], conclusion: `The service reads PASS=${hmac()} and\nAuth: Bearer-ish ${salt()}\nfrom its config.` });
    const text = JSON.stringify(findings);
    for (const value of [salt(), hmac()]) expect(text).not.toContain(value);
    expect(findings.commands[0]!.output).toBe(`SIGNING_SALT=${NO_CHANGE_VALUE_HIDDEN}\nHMAC: ${NO_CHANGE_VALUE_HIDDEN}\nOK=1`);
    expect(findings.conclusion).toContain(`PASS=${NO_CHANGE_VALUE_HIDDEN}`);
    expect(findings.conclusion).toContain(`\nAuth: ${NO_CHANGE_VALUE_HIDDEN}\nfrom its config.`);
  });

  it("also hides a value written in a command, and leaves ordinary text alone", () => {
    const command = buildNoChangeFindings({ commands: [{ command: `API_KEY=${hmac()} npm run build` }] }).commands[0]!.command;
    expect(command).toContain(`API_KEY=${NO_CHANGE_VALUE_HIDDEN}`);
    expect(command).not.toContain(hmac());
    expect(maskSecretValues("12 passed, 0 failed\nsrc/retry.ts:9: export const retry = true;")).toBe("12 passed, 0 failed\nsrc/retry.ts:9: export const retry = true;");
  });

  it("is linear in the size of a hostile output", () => {
    const started = performance.now();
    maskSecretValues(`${"a_".repeat(50_000)}\n${"KEY".repeat(30_000)}`);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("`omitted` never passes the schema's maximum", () => {
  it("is clamped where the block is built, in the contracts and in the worker, and where it is rebuilt", () => {
    const many = Array.from({ length: NO_CHANGE_FINDINGS_OMITTED_MAX + 200 }, (_, index) => ({ command: `c${String(index)}` }));
    const built = buildNoChangeFindings({ commands: many });
    expect(built.omitted).toBe(NO_CHANGE_FINDINGS_OMITTED_MAX);
    expect(NoChangeFindingsSchema.safeParse(built).success).toBe(true);
    const rebuilt = noChangeFindingsFrom({ commands: many.slice(0, 50), omitted: NO_CHANGE_FINDINGS_OMITTED_MAX + 5 })!;
    expect(rebuilt.omitted).toBe(NO_CHANGE_FINDINGS_OMITTED_MAX);
    expect(NoChangeFindingsSchema.safeParse(rebuilt).success).toBe(true);
    const recorder = new FindingsRecorder();
    for (let index = 0; index < NO_CHANGE_FINDINGS_OMITTED_MAX + 200; index += 1) recorder.observe({ type: "tool_execution_start", toolCallId: `t${String(index)}`, toolName: "bash", args: { command: `c${String(index)}` } });
    const found = recorder.build();
    expect(found.omitted).toBe(NO_CHANGE_FINDINGS_OMITTED_MAX);
    expect(found.commands).toHaveLength(10);
    expect(NoChangeFindingsSchema.safeParse(found).success).toBe(true);
  });
});

describe("the worker's recorder", () => {
  it("keeps the output of a shell command and not of a file read", () => {
    const recorder = new FindingsRecorder();
    recorder.observe({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "ls src" } });
    recorder.observe({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: { content: [{ type: "text", text: "a.ts\nb.ts" }] } });
    recorder.observe({ type: "tool_execution_start", toolCallId: "b", toolName: "read", args: { path: "src/a.ts" } });
    recorder.observe({ type: "tool_execution_end", toolCallId: "b", toolName: "read", result: { content: [{ type: "text", text: "FILE TEXT" }] } });
    expect(recorder.build().commands).toEqual([{ command: "ls src", output: "a.ts\nb.ts" }, { command: "read src/a.ts" }]);
  });
});

describe("secret names are matched as whole name parts", () => {
  it("splits a name at `_`, `-`, `.` and camelCase: API_KEY, apiKey and db.password are secret names; author, monkey and bypass are not", () => {
    for (const name of ["API_KEY", "apiKey", "db.password", "SIGNING_SALT", "HMAC", "session-token", "GITHUB_TOKEN", "AuthToken", "user_credentials", "COOKIE"]) expect(isSecretName(name), name).toBe(true);
    for (const name of ["author", "AUTHOR", "monkey", "bypass", "keyboard", "tokenizer", "PORT", "NODE_ENV", "passed"]) expect(isSecretName(name), name).toBe(false);
  });

  it("masks the value of the first kind and leaves the second kind alone, in an output and in the conclusion", () => {
    const text = `apiKey=${hmac()}\ndb.password: ${salt()}\nauthor=Ada\nmonkey=1\nbypass: yes\nAPI_KEY=${stripe()}`;
    const masked = maskSecretValues(text);
    expect(masked).toBe(`apiKey=${NO_CHANGE_VALUE_HIDDEN}\ndb.password: ${NO_CHANGE_VALUE_HIDDEN}\nauthor=Ada\nmonkey=1\nbypass: yes\nAPI_KEY=${NO_CHANGE_VALUE_HIDDEN}`);
    const found = buildNoChangeFindings({ commands: [{ command: "node dump.js", output: "author=Ada\nDB_PASS=x1" }], conclusion: "monkey=1 and apiKey=abc" });
    expect(found.commands[0]!.output).toBe(`author=Ada\nDB_PASS=${NO_CHANGE_VALUE_HIDDEN}`);
    expect(found.conclusion).toBe(`monkey=1 and apiKey=${NO_CHANGE_VALUE_HIDDEN}`);
  });

  it("reads inside a value that is not hidden", () => {
    expect(maskSecretValues(`URL=http://x.test/?a=1 API_TOKEN=${hmac()}`)).toBe(`URL=http://x.test/?a=1 API_TOKEN=${NO_CHANGE_VALUE_HIDDEN}`);
  });
});

describe("a command that refers to a secret variable shows no output", () => {
  it("is recognised for $NAME and ${NAME} whose name holds a secret word, and not for an ordinary variable", () => {
    for (const command of ["echo $GITHUB_TOKEN", 'echo "$DB_PASSWORD"', "echo ${API_KEY}", "printenv X", "curl -H \"x: $AUTH_HEADER\" https://x.test", "node -e 'console.log(process.env.X)' $SESSION_ID"]) expect(commandReadsSecrets(command), command).toBe(true);
    for (const command of ["echo $HOME", "echo $PWD", "echo $AUTHOR", 'echo "${NODE_ENV}"', "ls $TMPDIR"]) expect(commandReadsSecrets(command), command).toBe(false);
  });

  it("keeps no output of such a command in the block", () => {
    const found = buildNoChangeFindings({ commands: [{ command: "echo $GITHUB_TOKEN", output: hmac() }, { command: 'echo "$DB_PASSWORD"', output: salt() }, { command: "echo $HOME", output: "/home/x" }] });
    expect(found.commands.map((item) => item.output)).toEqual([NO_CHANGE_OUTPUT_HIDDEN, NO_CHANGE_OUTPUT_HIDDEN, "/home/x"]);
    expect(JSON.stringify(found)).not.toContain(hmac());
  });
});

describe("whether a task has a Slack thread", () => {
  it("reads the view's `threadUrl` and the record's `threadTs` alike, so the page and the app choose the same last line", () => {
    expect(noChangeHasThread(undefined)).toBe(false);
    expect(noChangeHasThread({})).toBe(false);
    expect(noChangeHasThread({ threadUrl: "https://x.slack.com/archives/C1/p1" })).toBe(true);
    expect(noChangeHasThread({ threadTs: "1760000000.000100" })).toBe(true);
  });
});
