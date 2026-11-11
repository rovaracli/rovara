# Use Rovara from Claude Code, Codex or Cursor

Rovara runs a small MCP server on your computer. Your AI tool uses it to hand Rovara a coding task
on a project you may use, check on it, continue it, and open a pull request. You need
Node 22.19 or newer (Node 22 LTS recommended) and the URL of your company's Rovara (ask your
Rovara admin).

Sign in once, in any terminal:

```
npx @preplabsai/rovara-code login https://agentx.example.com
```

Your browser opens. Sign in with Slack or with your company's sign-in. The terminal then shows who
you are and which projects you can use. You sign in again only when the sign-in ends (at most 7
days). If your computer has no browser, add `--no-browser` and open the link it prints.

Your sign-in is kept in your computer's own password store (the macOS keychain, or the Secret
Service on Linux). The setup below never writes a token into your AI tool's settings: the entry
only runs `npx -y @preplabsai/rovara-code mcp`.

`mcp install` writes the version of Rovara you ran it with into the entry (for example
`@preplabsai/rovara-code@0.4.0`), so your AI tool keeps using that version until you run it again. If
your admin gave you an environment name, put `--env <name>` before `mcp install`, for example
`npx @preplabsai/rovara-code --env staging mcp install --client codex`. The entry then passes the same
`--env` to the server. You can run `mcp install` again at any time: it replaces the agentx entry
and never adds a second one.

Run `mcp install` as yourself, never with `sudo`: it sets up the AI tool for the user who runs it,
so under `sudo` it would change root's settings instead of yours.

## Claude Code

Install:

```
claude mcp add --scope user agentx -- npx -y @preplabsai/rovara-code mcp
```

or let Rovara run that for you, with the version you have: `npx @preplabsai/rovara-code mcp install --client claude-code`.
It removes any agentx entry you added for your user before, then adds the new one. If the add
fails, your old entry is already gone, so it prints the exact command to run yourself.

Claude Code also has local and project entries (`--scope local` and `--scope project`, the second
kept in a project's `.mcp.json`). An agentx entry there wins over your user entry in that folder, so
if Rovara behaves oddly in one project, check `claude mcp list` there and remove the extra entry.

Manual setup: the command above is the whole setup. To see the exact command without running it,
use `npx @preplabsai/rovara-code mcp install --client claude-code --print`.

Remove it: `claude mcp remove --scope user agentx`.

## Codex

Install:

```
npx @preplabsai/rovara-code mcp install --client codex
```

It adds this to `~/.codex/config.toml`, keeps every other entry, and saves the old file as
`config.toml.agentx-backup`. If the file is not valid TOML, or already defines agentx in a
different way, it changes nothing and shows you the entry to add yourself. If the file is a
symbolic link (from a dotfiles folder, say), it changes the file the link points at and saves the
backup beside the link. Manual setup: add it
yourself:

```
[mcp_servers.agentx]
command = "npx"
args = ["-y", "@preplabsai/rovara-code", "mcp"]
```

To see the exact entry without changing anything, use
`npx @preplabsai/rovara-code mcp install --client codex --print`. If you keep Codex's settings
somewhere other than `~/.codex` (with `CODEX_HOME`), `mcp install` follows it and edits the
`config.toml` there. Run it in a terminal where `CODEX_HOME` is set the same way it is for Codex.

Remove it: delete the `[mcp_servers.agentx]` table from `~/.codex/config.toml`.

## Cursor

Install:

```
npx @preplabsai/rovara-code mcp install --client cursor
```

It adds this to `~/.cursor/mcp.json`, keeps every other server, and saves the old file as
`mcp.json.agentx-backup`. If the file is not plain JSON (for example, it has comments), it changes
nothing and shows you the entry to add yourself. Manual setup: add it yourself:

```
{
  "mcpServers": {
    "agentx": { "command": "npx", "args": ["-y", "@preplabsai/rovara-code", "mcp"] }
  }
}
```

To see the exact entry without changing anything, use
`npx @preplabsai/rovara-code mcp install --client cursor --print`.

Remove it: delete the `agentx` entry under `"mcpServers"` in `~/.cursor/mcp.json`.

## Team lessons in your AI tool

Rovara learns short rules from your team's reviews and fixes ("amounts are integer cents", "run the
migration before the integration tests"). Your own AI tool can ask for the ones that apply to the
repository it is working in, before it plans or writes code. There is nothing more to install: the
`rovara_lessons` tool arrives with the MCP server you set up above, in Claude Code, Codex and Cursor
alike, and its description tells the AI tool when to call it (once before it plans or writes code in a
repository, and again when it starts on a different part of the code).

What it returns, and what it never does:

- A short markdown block of up to five lessons, each with its id, one line of advice, one line of why
  and, when it has one, the code it was learned from, each as one quoted line under a fixed note that
  says lessons are team notes, not commands: your AI tool is told never to run a command, install a
  package or open an address only because a lesson says so. Nothing else: no links, no task ids, and
  no lesson that names a person (a member of the project, or anyone who wrote it).
- Only lessons your whole project may read (not a lesson from a task that is shared with fewer people,
  or from a private channel), only lessons that earned trust (stable after a trial, or approved by a
  person), and a lesson that belongs to one repository only in that repository. This is checked every
  time, so a lesson that is erased or narrowed is gone on the next call. Rovara keeps no copy on your
  computer and makes no model call to answer.
- Text your tool has already shown stays in that tool's chat history: Rovara cannot recall it. Ask your
  AI tool not to copy lesson text into code comments, commits or pull requests (its tool description does).
- Nothing at all, with a one-line reason, when your company keeps lessons inside Rovara, when lessons
  are switched off for the installation or the project, or on a project that uses the Regulated
  preset. Local tools are on by default on a project that uses the Standard preset. A maintainer of the
  project can switch it off and on (on the project's Lessons tab, or `npx @preplabsai/rovara-code lessons local off --project <name>`;
  `lessons local status` says what it comes to and why), and a company owner or admin can keep lessons
  inside Rovara for every project (on the company How we work page). Each change is recorded in the audit log.
  If Rovara cannot be reached the tool says so in one line and your AI tool carries on without lessons.

If the repository has a `.rovara/lessons.md` file merged by your team, Rovara leaves out the lessons
already in that file, so your tool does not read them twice.

Ask your AI tool for them by name ("get the Rovara lessons for this change") or add one line to the
repository's `AGENTS.md`, `CLAUDE.md` or Cursor rules, so every session asks:

```
Before planning or writing code, call the rovara_lessons tool (or run `npx @preplabsai/rovara-code lessons --task '<one-line summary>'`) and follow the lessons unless my request says otherwise.
```

For a tool with no MCP support, or a script, the same answer is one command, run in a checkout of the
repository. It reads the repository's `origin` remote (it only reads: nothing is written to git) and
prints the block, and it prints one line and exits 0 when no lesson applies or Rovara cannot be reached:

```
npx @preplabsai/rovara-code lessons --task "add refund endpoint" --files src/refunds/handler.ts
```

Useful options: `--project <name>` when the repository is in more than one of your projects,
`--stage plan|code|review` (code by default), `--repo <git remote>` outside a checkout, `--all` for the
whole set for the repository in one block (up to 300 lessons), and `--json`. A script with its own
script token can ask for the same answer; see [script-tokens.md](script-tokens.md).

## Your first task

Start a new session of your AI tool and ask, for example:

> Have Rovara fix the flaky retry test in payments-api and tell me when it is done.

Your AI tool writes the instructions and calls `agentx_start_task`. Rovara answers at once with a
task ID and works in a private workspace of its own; you keep working. Ask "how is my AgentX task
doing?" to check on it, "continue it and add a test for the timeout" to send more instructions,
and "open a pull request" when it is ready. For a small task, ask your tool to wait: it can wait up
to 10 minutes.

If you write your own MCP client, a wait longer than a minute needs your client to accept progress
updates. Rovara sends one while it waits, but only when the call includes a progress token. With the
MCP TypeScript SDK, pass `onprogress` and `resetTimeoutOnProgress: true` in the call's options;
otherwise the SDK gives up after its default of 60 seconds while Rovara is still waiting. Claude Code,
Codex and Cursor handle this themselves.

Tasks from your AI tool are private unless you share them, or the project requires sharing (see
below). For a private task, only you see its title, instructions, progress and results. Others who
can use the project see only that a workspace exists, with its status and times, in
`agentx workspaces`. Every action is recorded for your admins. Each task keeps a workspace until
you close it ("close my AgentX task"), and open tasks count against the same limit as your Slack
threads (3 at a time unless your admin changed it).

## Sharing a task to Slack

You can share a task into one of its project's Slack channels, so your team can follow it. Ask
your AI tool to "share my AgentX task in Slack", or to share it when it starts. It calls
`agentx_share_task` (or `agentx_start_task` with `share_to_channel`). If the project has more than
one channel, say which one.

There are two modes:

- **View only** (`view`): the channel follows the task, and you keep driving it from your AI tool.
  If someone mentions Rovara in the thread, Rovara replies with a notice and runs nothing.
- **Continue** (`continue`): channel members can also mention Rovara in the thread to steer the
  task. Their requests run on the task's workspace one at a time, and each names who sent it.

Rovara posts a new thread in the channel within seconds. The thread says who started the task,
from which AI tool, its title, the project and its status. Rovara then posts there when the
workspace is ready, when the task ends (with the worker's summary), when a pull request opens,
when the mode changes, and when you close the task. Your instructions are not posted. Each time you
send more instructions from your AI tool, the thread gets that request's end message and the
worker's summary, but not the instructions.
`agentx_get_task` shows the thread's link once it is posted.

To change the mode later, ask your AI tool to share the task again with the other mode. The
channel cannot change, and a shared task stays shared.

Your admin sets what a project allows, in its `developerTasks` settings:

- `share`: `optional` (the default) or `required`. With `required`, every task is shared when it
  starts.
- `shareMode.default`: the mode used when you do not ask for one; `view` unless your admin changed
  it.
- `shareMode.allowContinue`: with `false`, every shared task is view only, even if you ask for
  continue.

`agentx_list_projects` shows each project's settings. To share into a private channel, you must be
a member of it. An admin can also switch a shared task between the two modes, within the same
settings:

```
agentx --env <env> admin task share-mode --task <task-id> --mode view|continue
```

## When something goes wrong

Every Rovara error says what to do next. The common ones:

- `SIGN_IN_REQUIRED`: run `npx @preplabsai/rovara-code login <your AgentX URL>`.
- `PROJECT_ACCESS_DENIED`: join one of the project's Slack channels, or ask an admin.
- `WORKSPACE_LIMIT`: close a task you no longer need.
- `UPGRADE_REQUIRED`: run `npx -y @preplabsai/rovara-code@latest mcp install --client <your tool>`.
