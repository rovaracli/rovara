// Contract drift, text half: the sentences and string constants Rovara Code PRODUCES and Cloud parses STRICTLY (an exact template, a whitelist of sentences, an equality on a refusal's message). The schema
// comparison (compare.ts) cannot see them: they are plain strings in one schema, so Code changing a sentence made every open "Setup needs repair" card refuse (Code train 22 changed the card's tail while
// Cloud still matched the old one; DEC 254zzz447).
//
// A RULE names one Cloud parser, the Code file and the expression that builds the text Code sends (the file is read, not run: see text-eval.ts), and what "Cloud accepts it" means. `check` fails when the
// current Code text is not accepted. To cover a new strict parser of Code text, add a rule here AND refresh the pinned values (`snapshot`, see scripts/contract-drift.ts).
//
// Not covered, because Code writes them inline with no constant to read: the bare "route not found" 404 message that ~30 Cloud answers map to "not on Code yet", and the task-start-request messages.
// A change to those makes Cloud say "not found" instead of "not available yet"; it never refuses a card.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SETUP_REPAIR_NEW_TAIL, SETUP_REPAIR_OLD_TAIL, SETUP_REPAIR_SENTENCES } from "../../packages/contracts/src/app-setup-repair.js";
import { WIKI_SETUP_CODE_WORDS } from "../../packages/contracts/src/app-wiki-setup.js";
import { CODE_IN_PROGRESS, CODE_NO_PENDING, CODE_NOT_ADMIN, CODE_OWN_MEMBERSHIP, CODE_OWNER_ONLY } from "../../packages/cloud-server/src/member-routes.js";
import { CODE_CONSENT_WORDS } from "../../packages/cloud-server/src/wiki-setup-routes.js";
import * as repairRoutes from "../../packages/cloud-server/src/setup-repair-routes.js";
import { setupRepairBodyStep, SETUP_REPAIR_ACTIONS, SETUP_REPAIR_CHANGED_MAX } from "../../packages/cloud-server/src/setup-repair-routes.js";
import { evaluateCodeExpression, flatten, Unreadable, type ReadCodeFile } from "./text-eval.js";
import { CLOUD_ROOT } from "./run.js";

export const TEXT_PATH = path.join(CLOUD_ROOT, "tests/fixtures/code-contract-snapshot/code-text.json");

/** A step with the characters a failing command line has, so a parser that mishandles brackets or quotes shows. */
export const PROBE_STEP = "setup step 2 (npm ci in ./web) exited 1";

export interface TextValue {
  /** A name inside the rule; an object-valued expression is flattened to `label.member`. */
  readonly label: string;
  /** A TypeScript expression, evaluated in the scope of the rule's Code file. */
  readonly expr: string;
  /** A constant older Code releases do not have: unreadable is fine (the pinned value is then absent), but if Code has it, Cloud must take it. */
  readonly optional?: boolean;
}
export interface TextRule {
  readonly id: string;
  /** Cloud's parser, for the person reading a failure. */
  readonly cloud: string;
  readonly codeFile: string;
  readonly values: readonly TextValue[];
  /** Does Cloud's parser take this Code text? `key` is `label` or `label.member`. */
  readonly accepts: (text: string, key: string) => boolean;
  /** A check over ALL of the rule's values together (a length of words joined, a constant Cloud must have): the failures, as plain sentences. `values` is keyed `label` or `label.member`. */
  readonly check?: (values: Readonly<Record<string, string>>) => string[];
}

/** A Cloud export by name, for a parser another branch adds: read at run time so a Cloud without it FAILS the rule with a clear line instead of failing to compile. */
const cloudExport = (name: string): unknown => (repairRoutes as unknown as Record<string, unknown>)[name];
const flatStrings = (value: unknown): string[] => (typeof value === "string" ? [value] : typeof value === "object" && value !== null ? Object.values(value).flatMap(flatStrings) : []);

const equalsRule = (id: string, cloud: string, codeFile: string, pairs: ReadonlyArray<readonly [label: string, expr: string, cloudText: string]>): TextRule => ({
  id, cloud, codeFile,
  values: pairs.map(([label, expr]) => ({ label, expr })),
  accepts: (text, key) => pairs.some(([label, , cloudText]) => label === key && text === cloudText),
});

const ROWS_FILE = "packages/broker/src/core/setup-agent/recheck-rows.ts";

export const TEXT_RULES: readonly TextRule[] = [
  {
    id: "setup-repair-card-body",
    cloud: "packages/cloud-server/src/setup-repair-routes.ts BODY_STEP (strict template of the card's sentence; anything else refuses the whole read)",
    codeFile: "packages/broker/src/core/setup-agent/recheck-rows.ts",
    values: [
      { label: "card-body", expr: `setupRepairCardOf(${JSON.stringify(PROBE_STEP)}).body` },
      { label: "tail", expr: "SETUP_WORK_CONTINUES_TAIL", optional: true },
    ],
    // The tail must be one of the two Cloud knows, and the whole sentence must come back with the probe step in it.
    accepts: (text, key) => (key === "card-body" ? setupRepairBodyStep(text) === PROBE_STEP : text === SETUP_REPAIR_NEW_TAIL || text === SETUP_REPAIR_OLD_TAIL),
  },
  {
    id: "wiki-build-words",
    cloud: "packages/cloud-server/src/wiki-setup-routes.ts KNOWN_SENTENCES / PASS_WORDS (an answer carrying any other sentence refuses the read)",
    codeFile: "packages/contracts/src/wiki-build.ts",
    values: [{ label: "words", expr: "WIKI_BUILD_WORDS" }],
    accepts: (text) => (Object.values(WIKI_SETUP_CODE_WORDS) as string[]).includes(text),
  },
  equalsRule("setup-repair-card-words", "packages/cloud-server/src/setup-repair-routes.ts SETUP_REPAIR_ACTIONS and the card's title (exact match of the words Code puts on the card's actions and title)", ROWS_FILE, [
    ["fixSetup", "SETUP_REPAIR_WORDS.fixSetup", SETUP_REPAIR_ACTIONS["fix_setup"] ?? ""],
    ["approveNewSetup", "SETUP_REPAIR_WORDS.approveNewSetup", SETUP_REPAIR_ACTIONS["approve_new_setup"] ?? ""],
    ["title", "SETUP_REPAIR_WORDS.title", SETUP_REPAIR_SENTENCES.title],
  ]),
  {
    // The setup-agent's repair card (the Setup tab's `repair` field): the fixed words after the card's sentence, and the "Fix setup" label with Code's budget in it.
    id: "setup-agent-repair-words",
    cloud: "packages/cloud-server/src/setup-repair-routes.ts SETUP_AGENT_REPAIR_WORDS / SETUP_AGENT_FIX_LABEL (a card whose words are not these is refused)",
    codeFile: "packages/broker/src/core/setup-agent/repair-draft.ts",
    values: [
      { label: "words", expr: "REPAIR_WORDS" },
      { label: "fix-label-400", expr: "fixSetupLabel(400)" },
      { label: "fix-label-150", expr: "fixSetupLabel(150)" },
    ],
    accepts: (text, key) => {
      // A Cloud without the parser is reported once by `check`, not once per word.
      if (key.startsWith("words.")) return cloudExport("SETUP_AGENT_REPAIR_WORDS") === undefined || flatStrings(cloudExport("SETUP_AGENT_REPAIR_WORDS")).includes(text);
      const label = cloudExport("SETUP_AGENT_FIX_LABEL");
      return label === undefined || (label instanceof RegExp && label.test(text));
    },
    check: () => (cloudExport("SETUP_AGENT_REPAIR_WORDS") === undefined || cloudExport("SETUP_AGENT_FIX_LABEL") === undefined ? ["Cloud has no strict parser for the setup-agent repair words yet (SETUP_AGENT_REPAIR_WORDS / SETUP_AGENT_FIX_LABEL in setup-repair-routes.ts): the branch that adds it must merge with this rule"] : []),
  },
  {
    // `changed` is Code's `setupDriftWords(classes)`: every class word joined ("a, b and c"). Cloud's card parser cuts it at SETUP_REPAIR_CHANGED_MAX: eight or more classes at once refused the whole card on staging and prod.
    id: "setup-repair-changed-words",
    cloud: "packages/cloud-server/src/setup-repair-routes.ts SETUP_REPAIR_CHANGED_MAX (the longest `changed` text the card parser takes)",
    codeFile: "packages/contracts/src/setup-snapshot.ts",
    values: [{ label: "words", expr: "SETUP_WATCH_WORDS" }],
    accepts: () => true,
    check: (values) => {
      const words = Object.entries(values).filter(([key]) => key.startsWith("words.")).map(([, word]) => word);
      // setupDriftWords: all but the last joined with ", ", then " and " and the last (the longest text a drift of every class gives).
      const longest = words.length < 2 ? (words[0]?.length ?? 0) : words.slice(0, -1).join(", ").length + " and ".length + words[words.length - 1]!.length;
      return longest > SETUP_REPAIR_CHANGED_MAX ? [`Code's longest \`changed\` text (setupDriftWords of all ${String(words.length)} classes) is ${String(longest)} characters; Cloud's card parser takes at most ${String(SETUP_REPAIR_CHANGED_MAX)} (SETUP_REPAIR_CHANGED_MAX), so a drift in enough classes at once refuses the whole card`] : [];
    },
  },
  equalsRule("upkeep-consent-words", "packages/cloud-server/src/wiki-setup-routes.ts CODE_CONSENT_WORDS (exact match of Code's 403 message)", "packages/contracts/src/upkeep.ts", [
    ["notAllowed", "SYSTEM_RUNS_CONSENT_WORDS.notAllowed", CODE_CONSENT_WORDS.notAllowed],
    ["needsConsent", "SYSTEM_RUNS_CONSENT_WORDS.needsConsent", CODE_CONSENT_WORDS.needsConsent],
  ]),
  equalsRule("member-refusal-words", "packages/cloud-server/src/member-routes.ts CODE_* (exact match of Code's member refusals)", "packages/broker/src/aws/company-member-routes.ts", [
    ["own-membership", "OWN_MEMBERSHIP", CODE_OWN_MEMBERSHIP],
    ["owner-only", "OWNER_ONLY", CODE_OWNER_ONLY],
    ["not-admin", "NOT_FOUND", CODE_NOT_ADMIN],
    ["no-pending-handover", "NO_PENDING_HANDOVER", CODE_NO_PENDING],
    ["handover-in-progress", "HANDOVER_IN_PROGRESS", CODE_IN_PROGRESS],
  ]),
];

export interface CodeText {
  readonly format: 1;
  readonly source: { readonly repository: string; readonly ref: string; readonly sha: string };
  /** `<rule id>/<label>[.<member>]` to the text Code builds. */
  readonly values: Readonly<Record<string, string>>;
  /** Values this reader could not evaluate (a Code refactor moved them): each is a failure until the rule is updated. */
  readonly unreadable: Readonly<Record<string, string>>;
}

/** Read the rules' Code text from files (`read`), without running Code. */
export function collectCodeText(read: ReadCodeFile, source: CodeText["source"], rules: readonly TextRule[] = TEXT_RULES): CodeText {
  const values: Record<string, string> = {}, unreadable: Record<string, string> = {};
  for (const rule of rules) {
    for (const value of rule.values) {
      const key = `${rule.id}/${value.label}`;
      try { Object.assign(values, flatten(evaluateCodeExpression(read, rule.codeFile, value.expr), key)); } catch (error) {
        if (!(error instanceof Unreadable)) throw error;
        unreadable[key] = error.message;
      }
    }
  }
  return { format: 1, source, values, unreadable };
}

/** Every Code text a rule names that Cloud's parser refuses, or that could not be read. Empty means Cloud takes everything Code says. */
export function textDrifts(code: CodeText, rules: readonly TextRule[] = TEXT_RULES): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    if (rule.check !== undefined) {
      const prefix = `${rule.id}/`;
      const own = Object.fromEntries(Object.entries(code.values).filter(([key]) => key.startsWith(prefix)).map(([key, text]) => [key.slice(prefix.length), text]));
      for (const failure of rule.check(own)) out.push(`TEXT ${rule.id}: ${failure} (${rule.cloud})`);
    }
    for (const value of rule.values) {
      const key = `${rule.id}/${value.label}`;
      const own = Object.keys(code.values).filter((name) => name === key || name.startsWith(`${key}.`));
      const why = code.unreadable[key];
      if (value.optional === true && own.length === 0) continue;
      if (why !== undefined) out.push(`TEXT ${key}: Code's ${value.expr} in ${rule.codeFile} could not be read (${why}); update the rule in scripts/contract-drift/text-rules.ts`);
      else if (own.length === 0) out.push(`TEXT ${key}: the pinned Code text has no value for it; refresh with the snapshot command`);
      for (const name of own) {
        const text = code.values[name]!;
        if (!rule.accepts(text, name.slice(rule.id.length + 1))) out.push(`TEXT ${name}: Code now says ${JSON.stringify(text)}; Cloud's parser refuses it (${rule.cloud})`);
      }
    }
  }
  return out;
}

export const readPinnedText = (file = TEXT_PATH): CodeText => JSON.parse(readFileSync(file, "utf8")) as CodeText;
export function writePinnedText(text: CodeText, file = TEXT_PATH): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(text, null, 2)}\n`);
}

/** The Code text at a ref of a repository (`git show`, nothing is checked out) or in a working tree. */
export function codeTextFrom(source: { readonly dir: string } | { readonly repo: string; readonly ref: string }, rules: readonly TextRule[] = TEXT_RULES): CodeText {
  const git = (repo: string, args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
  if ("dir" in source) {
    const root = path.resolve(source.dir);
    return collectCodeText((file) => (existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), "utf8") : undefined), { repository: "PrepLabsAI/Rovara", ref: "working tree", sha: git(root, ["rev-parse", "HEAD"]) }, rules);
  }
  const sha = git(source.repo, ["rev-parse", `${source.ref}^{commit}`]);
  return collectCodeText((file) => { try { return execFileSync("git", ["-C", source.repo, "show", `${sha}:${file}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); } catch { return undefined; } }, { repository: "PrepLabsAI/Rovara", ref: source.ref, sha }, rules);
}
