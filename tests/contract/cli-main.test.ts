import { describe, expect, it } from "vitest";
import { createCliProgram } from "../../packages/cli/src/main.js";

describe("AgentX executable command surface", () => {
  it("exposes administration and developer sign-in; developer tasks come from AI tools", () => {
    const program = createCliProgram();

    expect(program.commands.map((command) => command.name())).toEqual(["login", "logout", "whoami", "workspaces", "chatgpt", "audit", "org", "connections", "lessons", "chains", "sessions", "session", "home", "agents", "skills", "approvals", "spend-requests", "task", "github", "sso", "signin", "config", "loop", "doctor", "upgrade", "bundle", "destroy", "admin", "slack", "project", "channel", "connector", "alerts", "env", "deploy", "init", "mcp"]);

    expect(subcommands(program, "org")).toEqual(["members", "role", "remove", "leave", "comment-triggers", "spend", "guardrails", "sources"]);
    // Plan 3, Task 14b: the opt-outs of the comment rule are listed here and set on the confirmation page; no command sets one.
    expect(program.commands.find((command) => command.name() === "org")?.commands.find((command) => command.name() === "comment-triggers")?.commands.map((command) => command.name())).toEqual(["list"]);
    expect(subcommands(program, "connections")).toEqual(["list", "add", "remove", "check"]);
    // Plan 5, Task 23: a session is shown, followed, commented on, told, stopped, retried, taken over and shared from the command line.
    expect(subcommands(program, "session")).toEqual(["start", "show", "follow", "unfollow", "comment", "tell", "answer", "stop", "retry", "take-over", "share", "merge", "link"]);
    expect(subcommands(program, "github")).toEqual(["oauth", "connect", "list", "disconnect"]);

    const admin = program.commands.find((command) => command.name() === "admin");
    expect(admin?.commands.map((command) => command.name())).toEqual(["project", "runtime-installation", "workspace", "budget", "egress", "slack", "eval", "credential", "turns", "task", "lessons-replay", "changes", "audit"]);
    expect(subcommands(admin, "project")).toEqual(["register", "grant", "revoke"]);
    expect(subcommands(admin, "workspace")).toEqual(["list", "cancel", "stop"]);
    expect(subcommands(admin, "budget")).toEqual(["set"]);
    expect(subcommands(admin, "slack")).toEqual(["bind", "connect-team", "disconnect-team", "unbind"]);
    expect(subcommands(program, "slack")).toEqual(["bind", "unbind"]);
    expect(subcommands(admin, "eval")).toEqual(["enable", "show", "disable", "batch"]);
    expect(admin?.commands.find((command) => command.name() === "eval")?.commands.find((command) => command.name() === "batch")?.commands.map((command) => command.name())).toEqual(["start", "show", "stop", "results"]);
    expect(subcommands(admin, "credential")).toEqual(["register", "authorize", "list"]);
    expect(subcommands(admin, "turns")).toEqual(["export"]);
    expect(subcommands(admin, "task")).toEqual(["share-mode", "e2e-replay", "lessons-replay"]);
    expect(subcommands(admin?.commands.find((c) => c.name() === "task"), "lessons-replay")).toEqual(["start", "approve", "close", "evidence", "show"]);
    expect(subcommands(admin, "lessons-replay")).toEqual(["import-snapshot", "settings", "subject", "model"]);
    expect(subcommands(admin, "runtime-installation")).toEqual(["challenge", "register"]);

    expect(subcommands(program, "signin")).toEqual(["show", "enable", "disable", "cloud", "check", "unlink", "link"]);
    expect(subcommands(program, "loop")).toEqual(["init", "add", "enroll", "remove", "start", "stop", "status", "run", "do", "quick", "full", "review", "contribute", "check", "mcp"]);
    expect(subcommands(program, "chatgpt")).toEqual(["connect", "status", "disconnect"]);
    expect(subcommands(program, "audit")).toEqual(["log", "export", "verify", "open"]);
    expect(subcommands(admin, "audit")).toEqual(["log", "export"]);
    expect(subcommands(program, "mcp")).toEqual(["install"]);
    expect(subcommands(program, "project")).toEqual(["add", "setup-approve", "model-check", "hooks", "create", "show", "archive", "restore", "code-settings", "lessons-repo", "check", "members", "add-member", "remove-member", "settings", "agents", "connectors", "ai"]);
    expect(program.commands.find((command) => command.name() === "project")?.commands.find((command) => command.name() === "model-check")?.commands.map((command) => command.name())).toEqual(["discover", "test", "drive"]);
    expect(subcommands(program, "channel")).toEqual(["add"]);
    expect(subcommands(program, "connector")).toEqual(["add"]);
    expect(subcommands(program, "alerts")).toEqual(["test"]);

    const env = program.commands.find((command) => command.name() === "env");
    expect(env?.commands.map((command) => command.name())).toEqual(["list", "use", "adopt"]);
  });

  it("keeps no developer workflow or runtime routing option", () => {
    const program = createCliProgram();
    const rootCommands = program.commands.map((command) => command.name());

    // Release 0.4.17: `slack` is a developer command again, for an organization owner or admin to bind their own project's channel (`slack bind|unbind`);
    // it carries no workflow. The operator's form stays under `admin slack`.
    for (const retired of ["status", "conversation", "pr", "cancel"]) {
      expect(rootCommands).not.toContain(retired);
    }
    expect(allCommands(program).map((command) => command.name())).not.toContain("prepare");

    const optionNames = allCommands(program).flatMap((command) =>
      command.options.map((option) => option.long),
    );
    expect(optionNames).not.toContain("--runtime-session-id");
    expect(optionNames).not.toContain("--prompt");

    // --orchestrator-model reappears, but only on `init` (an install-time Bedrock model choice, not
    // the retired ad-hoc runtime-routing flag this guard was originally written against): every
    // other command, including the root program itself, must never carry it.
    for (const command of allCommands(program)) {
      if (command.name() === "init") continue;
      expect(command.options.map((option) => option.long)).not.toContain("--orchestrator-model");
    }
    const init = program.commands.find((command) => command.name() === "init");
    expect(init?.options.map((option) => option.long)).toContain("--orchestrator-model");
  });
});

describe("hidden chains and triggers (owner decision 2026-11-07)", () => {
  it("leaves chains and every triggers group out of help, and keeps the commands so nothing existing breaks", () => {
    const program = createCliProgram();
    const help = program.helpInformation();
    expect(help).toContain("agents");
    expect(help).not.toMatch(/^\s+chains\b/mu);
    const chains = program.commands.find((command) => command.name() === "chains");
    const agents = program.commands.find((command) => command.name() === "agents");
    expect(chains).toBeDefined();
    expect(agents?.helpInformation()).not.toMatch(/^\s+triggers\b/mu);
    expect(chains?.commands.some((command) => command.name() === "triggers")).toBe(true);
    expect(agents?.commands.some((command) => command.name() === "triggers")).toBe(true);
    for (const group of [chains, chains?.commands.find((command) => command.name() === "triggers"), agents?.commands.find((command) => command.name() === "triggers")]) expect((group as unknown as { _hidden: boolean })._hidden).toBe(true);
    // Positive control: a command that stays offered is in help.
    expect(help).toMatch(/^\s+sessions\b/mu);
    expect(agents?.helpInformation()).toMatch(/^\s+list\b/mu);
  });
});

function subcommands(
  admin: ReturnType<typeof createCliProgram> | undefined,
  group: string,
): string[] {
  const command = admin?.commands.find((candidate) => candidate.name() === group);
  return command?.commands.map((candidate) => candidate.name()) ?? [];
}

function allCommands(root: ReturnType<typeof createCliProgram>): typeof root[] {
  return [root, ...root.commands.flatMap((command) => allCommands(command))];
}
