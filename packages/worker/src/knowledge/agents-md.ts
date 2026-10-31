// Knowledge resolver (K1, C1): AGENTS.md, AGENTS.override.md and CLAUDE.md, at the root and nested.
// Kiro's steering page: AGENTS.md "do not support inclusion modes and are always included", so the file is read as plain text and its
// mode comes from where it sits: at the repository root it is always on; below the root it applies to the files under its own folder.
import type { KnowledgeFormatReader } from "./reader.js";
import { folderOf } from "./reader.js";

const AGENTS_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD"] as const;
const CLAUDE_NAMES = ["CLAUDE.md", "CLAUDE.MD"] as const;

const nestedActivation = (scopeDir: string) => ({ activation: "fileMatch" as const, patterns: [`${scopeDir}/**`] });

export const agentsMdReader: KnowledgeFormatReader = {
  id: "agents_md",
  discovery: { rootFiles: AGENTS_NAMES, nestedNames: AGENTS_NAMES },
  accepts: (path) => (AGENTS_NAMES as readonly string[]).includes(path.slice(path.lastIndexOf("/") + 1)),
  parse: (path, text, context) => ({
    ok: true,
    value: {
      ...(context.nested ? nestedActivation(folderOf(path)) : { activation: "always" as const }),
      body: text,
      imports: "none",
    },
  }),
};

export const claudeMdReader: KnowledgeFormatReader = {
  id: "claude_md",
  // `.claude/CLAUDE.md` is the project memory Claude Code reads beside the root file.
  discovery: { rootFiles: [...CLAUDE_NAMES, ".claude/CLAUDE.md"], nestedNames: CLAUDE_NAMES },
  accepts: (path) => (CLAUDE_NAMES as readonly string[]).includes(path.slice(path.lastIndexOf("/") + 1)) || path === ".claude/CLAUDE.md",
  parse: (path, text, context) => ({
    ok: true,
    value: {
      ...(context.nested ? nestedActivation(folderOf(path)) : { activation: "always" as const }),
      body: text,
      imports: "claude",
    },
  }),
};
