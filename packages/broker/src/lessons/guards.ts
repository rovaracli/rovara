// Learning v2 text guards (controls C6, C7, C12). Pure code: what a lesson may never ask for, and what always sends a lesson to two people.
import { cleanLessonText, foldForMatching, redactText } from "@agentx/contracts";

/** Free text from a person or a system, made safe for a model and for storage: secrets redacted, hidden characters and markup removed, bounded. */
export function cleanForLearning(text: string, maxChars: number): string {
  return cleanLessonText(redactText(text), maxChars);
}

/**
 * Text that asks for a change to tools, permissions, domains, budgets, models, approvals or checks' authority. A lesson is advice: it has no field for
 * these and its text may not request them either (P8). Matching is broad on purpose; a refused lesson only costs a person a re-word.
 */
const CAPABILITY_REQUESTS: readonly RegExp[] = [
  /\b(grant|give|enable|allow|add|unlock|permit)\b[^.\n]{0,40}\b(tools?|permissions?|access|domains?|hosts?|websites?|network|egress|commands?|shell|credentials?|secrets?)\b/iu,
  /\b(allowed?\s*domains?|allowedDomains|allow-?list|egress)\b/iu,
  /\b(increase|raise|lift|remove|bump|change|set)\b[^.\n]{0,30}\b(budget|spend(ing)?\s*(limit|cap)|limit|cap|quota)\b/iu,
  /\b(change|switch|use|swap|pick)\b[^.\n]{0,20}\b(the\s+)?(model|models)\b/iu,
  /\b(auto-?approve|approve\s+automatically|without\s+(an?\s+)?approval|skip\s+(the\s+)?approvals?|bypass\s+(the\s+)?approvals?|no\s+approval\s+needed)\b/iu,
  /\b(run|execute)\b[^.\n]{0,20}\b(any|arbitrary|unrestricted)\b[^.\n]{0,20}\bcommands?\b/iu,
  /^\s*(tools|grants|commands|allowedDomains|permissions|allowed-tools)\s*:/imu,
];
export function requestsCapabilityChange(...texts: readonly string[]): boolean {
  return texts.map(foldForMatching).some((text) => CAPABILITY_REQUESTS.some((pattern) => pattern.test(text)));
}

/**
 * Words that put a lesson in front of two people (tier 2): tests, checks, CI, coverage, security, auth, secrets, permissions, dependencies, network or
 * domains, skipping or disabling anything, and approvals. Over-escalation is accepted in the pilot (design Q12); the word list is reviewed weekly.
 */
const ESCALATION: readonly RegExp[] = [
  /\b(tests?|testing|test\s+suites?|unit\s+tests?|integration\s+tests?|e2e|flaky|coverage|assert(ion)?s?|mock(s|ing)?)\b/iu,
  /\b(checks?|checking|ci|pipelines?|lint(er|ing)?|typecheck(ing)?|build\s+gates?|gates?)\b/iu,
  /\b(security|secure|auth|authn|authz|authentication|authorization|authori[sz]e[sd]?|secrets?|credentials?|tokens?|passwords?|api[-\s]?keys?|encrypt\w*|crypto\w*|tls|ssl|certificates?|verify\s*=\s*false|sandbox(es|ed)?|vulnerab\w*|cve)\b/iu,
  /\b(permissions?|privileges?|roles?|iam|acl|access\s+control|admin)\b/iu,
  /\b(dependenc(y|ies)|packages?\s+versions?|lockfiles?|upgrade|downgrade|npm|pip|supply\s+chain)\b/iu,
  /\b(network|domains?|hosts?|egress|firewall|proxy|proxies|urls?|endpoints?\s+allow)\b/iu,
  /\b(skip(s|ped|ping)?|disabl(e|es|ed|ing)|bypass(es|ed|ing)?|ignor(e|es|ed|ing)|turn(s|ed|ing)?\s+off|suppress(es|ed|ing)?|no\s+need\s+to|needn'?t|don'?t\s+(need|have)\s+to|override|workaround)\b/iu,
  /\b(approv\w*|reviewers?|code\s+review|sign-?offs?|rubber-?stamp\w*)\b/iu,
];
export function hasEscalationWords(...texts: readonly string[]): boolean {
  return texts.map(foldForMatching).some((text) => ESCALATION.some((pattern) => pattern.test(text)));
}

/**
 * Tier 0 is a positive shape: a plain statement of where something is or what it is called. Anything that tells the agent to run, install, fetch,
 * download, execute, pipe, source or change something goes to people. A list of known commands is always one spelling behind, so this is a list of the
 * KINDS of instruction: verbs, script-shaped tokens, make targets, hosts with or without a scheme, shell syntax, environment assignments.
 */
const COMMANDS: readonly RegExp[] = [
  // Verbs that make a sentence an instruction to act on the machine.
  /\b(run|runs|running|execute|executes|executing|invoke|invokes|invoking|install|installs|installing|reinstall|download|downloads|downloading|fetch|fetches|fetching|bootstrap|bootstraps|provision|deploy|launch|spawn|restart|kill|pipe|piped|pipes|sourcing|curl|wget|scp|rsync|ncat|telnet|sudo|chmod|chown|eval|exec|iwr|iex|invoke-expression|invoke-webrequest)\b/iu,
  /\b(put|add|append|prepend)\b[^.\n]{0,30}\b(on|to|in)\s+(the\s+)?(path|ld_library_path|pythonpath)\b/iu,
  // Package managers and runners, any verb after them.
  /\b(pip3?|pipx|uvx|poetry|conda|npm|npx|pnpm|yarn|deno|brew|apt(-get)?|yum|dnf|apk|gem|cargo|dotnet|nuget|choco|winget|scoop|helm|kubectl|terraform|docker|podman|cmake|gradle|mvn|rake|bazel|git)\s+[a-z-]+/iu,
  /\b(go\s+(run|install|get|build|test|generate)|uv\s+(tool|pip|run|sync|add|venv)|bun\s+(run|install|add|x)|make\s+(?!sure\b|it\b|the\b|a\b|an\b|this\b|that\b|them\b|your\b|our\b|no\b|any\b)[a-z][\w-]*)\b/iu,
  /\b(python3?|node|ruby|perl|php|bash|sh|zsh|pwsh|powershell|java)\s+(-[a-zA-Z-]+\b|[\w-]*[./][\w./-]*)/iu,
  /\|\s*(sh|bash|zsh|python3?|node|perl|ruby|iex)\b/iu,
  // Script-shaped tokens and paths.
  /(^|[\s`'"(])\.{1,2}\/[\w.-]+/u, /\b[\w.-]+\.(sh|ps1|bat|cmd|zsh|bash|run|bin|exe|msi|pkg|deb|rpm)\b/iu, /(^|\/)scripts?\//iu,
  // URLs with or without a scheme, and IP addresses.
  /\bhttps?:\/\//iu, /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|xyz|sh|app|cloud|info|biz|ru|cn|tk|ml|ga|cf|gq|top|site|online|link|zip|mov|ai|ly|gl|gd)(?:\/\S*)?\b/iu, /\b\d{1,3}(?:\.\d{1,3}){3}\b/u,
  // Shell syntax and environment.
  /\brm\s+-/iu, /\b(export\s+)?[A-Z][A-Z0-9_]{2,}=\S+/u, /&&|\|\||;\s*\w+\s+-|\$\(|\$\{|`[^`\n]*\s[^`\n]*`|>\s*\/|\/dev\//u,
];
export function hasCommandOrUrl(...texts: readonly string[]): boolean {
  return texts.map(foldForMatching).some((text) => COMMANDS.some((pattern) => pattern.test(text)));
}

/**
 * Paths where a wrong lesson weakens what protects the project: tests, CI, test-runner and lint configs, git hooks, code owners, scripts, auth and security
 * code, lockfiles and manifests, container and infra files. A lesson scoped to, or citing, any of them needs two people whatever its text says.
 * Globs are matched as plain strings, so `tests/**` matches. Paths are folded for look-alike letters first.
 */
const RISKY_PATHS: readonly RegExp[] = [
  /(^|\/)(tests?|__tests__|specs?|e2e|fixtures|cypress|playwright|mocks?|__mocks__|testing|qa)(\/|$)/iu, /\.(test|spec)\.[A-Za-z0-9]+/iu, /(^|\/)\*?[A-Za-z0-9_-]*(test|spec)[A-Za-z0-9_-]*\*?(\.|\/|$)/iu,
  /(^|\/)\.github(\/|$)/iu, /(^|\/)\.gitlab-ci/iu, /(^|\/)(Jenkinsfile|\.circleci|\.buildkite|azure-pipelines|buildspec|\.travis)/iu, /(^|\/)ci(\/|$)/iu,
  /(^|\/)(jest|vitest|karma|mocha|cypress|playwright|pytest|tox|nox|coverage|nyc|codecov|sonar|eslint|prettier|stylelint|tslint|babel|webpack|rollup|vite|tsconfig|pyproject|setup|noxfile|conftest|lefthook|commitlint|renovate|dependabot)[\w.-]*(\.(js|cjs|mjs|ts|json|ya?ml|toml|cfg|ini|rc))?$/iu,
  /(^|\/)(\.husky|\.pre-commit-config|\.eslintrc|\.prettierrc|\.babelrc|\.editorconfig|CODEOWNERS|\.git[a-z]*|hooks|githooks)(\/|\.|$)/iu, /(^|\/)scripts?(\/|$)/iu, /(^|\/)(bin|tools|tooling|build)(\/|$)/iu,
  /(^|\/)\*?[\w-]*(auth|authn|authz|oauth|oidc|saml|sso|login|logout|signin|signup|session|jwt|token|password|passwd|credential|cred|secret|security|sanitiz|csrf|cors|rbac|policy|policies|permission|privilege|crypto|cipher|keys?|cert|tls|ssl|iam|acl|admin|guard|middleware)[\w-]*\*?(\/|\.|$)/iu,
  /(^|\/)(package-lock\.json|package\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile(\.lock)?|Cargo\.(lock|toml)|go\.(sum|mod)|requirements[A-Za-z0-9_.-]*\.txt|Gemfile(\.lock)?)$/iu,
  /(^|\/)(Dockerfile[A-Za-z0-9_.-]*|docker-compose[A-Za-z0-9_.-]*|Makefile|\.env[A-Za-z0-9_.-]*|\.npmrc|\.pypirc|\.netrc|terraform|infra|deploy|helm|k8s|kubernetes|ansible|cdk)(\/|$|\.)/iu,
];
export function touchesRiskyPath(paths: readonly string[]): boolean {
  return paths.map(foldForMatching).some((path) => RISKY_PATHS.some((pattern) => pattern.test(path)));
}

/** Words that flip a rule's direction, for the curator's "opposite polarity" check. */
const POSITIVE = /\b(always|must|use|prefer|do|enable|require|add|keep)\b/iu;
const NEGATIVE = /\b(never|avoid|don'?t|do\s+not|must\s+not|disable|remove|stop|without|instead\s+of)\b/iu;
export function polarity(text: string): "positive" | "negative" | "none" {
  // A negation anywhere flips the direction of the advice ("never use X" contains "use"), so it wins.
  return NEGATIVE.test(text) ? "negative" : POSITIVE.test(text) ? "positive" : "none";
}
/** True when exactly one of two texts carries a negation, so that a high embedding similarity cannot be trusted to mean "the same advice". */
export function oppositePolarity(a: string, b: string): boolean {
  return (polarity(a) === "negative") !== (polarity(b) === "negative");
}

/** A quoted, forwarded or pasted block inside a person's text carries the trust of its author, which is unknown here: treat it as an outsider's (C3). */
const QUOTED: readonly RegExp[] = [
  /^\s*>/mu, /(^|\n)\s*-{2,}\s*(original|forwarded)\s+message/iu, /\bforwarded\s+message\b/iu, /(^|\n)\s*(from|sent|to|subject)\s*:.*\n\s*(from|sent|to|subject|date)\s*:/iu,
  /\b(they|he|she|someone|\w+)\s+(said|wrote|asked)\s*:\s*["“]/iu, /\bfwd?:\s/iu,
];
export function looksQuoted(text: string): boolean {
  return QUOTED.some((pattern) => pattern.test(text));
}
