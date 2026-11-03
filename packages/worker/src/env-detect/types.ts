// Environment detectors (E2, design proof-test-env section 4.1): CODE reads the repository first and says what it found, with where (file and line) or which detector. The read-only setup agent then fills only the gaps.
// Detectors are pure over a bounded reader: they never run a command and never read outside the file list they are given.
import type { CheckKind, ProjectCommand, TestEnvDependencyKind } from "@agentx/contracts";

/** Where a detected value came from: a file and line, or a detector's name. */
export type DetectedSource = { path: string; line: number } | `detector:${string}` | `recipe:${string}@${string}`;

export interface Located<T> { value: T; source: DetectedSource }

export interface DetectedCheck {
  /** Unique within a detection (`unit`, `lint`, `typecheck`, ...). */
  id: string;
  label: string;
  command: ProjectCommand;
  kind: CheckKind;
  reportPath?: string;
  coveragePath?: string;
  sarifPath?: string;
  /** Where the report path and the coverage path came from (a file and line, or the detector's own default); the proposal cites them beside the check. */
  reportSource?: DetectedSource;
  coverageSource?: DetectedSource;
  /** Set only on a check a company recipe made (a path no detector cites): the proposal then cites it beside the check, so no value of a recipe reads as the model's. */
  sarifSource?: DetectedSource;
  selectArgs?: string[];
}

export type DetectedServiceKind = "sagemaker_runtime" | "http";
export interface DetectedService {
  kind: DetectedServiceKind;
  /** The endpoint name (SageMaker) or the host (http). A SageMaker client with no literal endpoint name is reported as a question instead. */
  target: string;
}

export interface DetectedIac { provider: "cdk" | "cloudformation" | "terraform"; path: string }

/** A file and line a dependency was seen at (test services D1-D7). Never a detector name: a candidate's evidence is always something a person can open. */
export interface DependencyEvidence { path: string; line: number }

/** How sure a detector is: `declared` (a compose, CI or IaC file says it runs), `used` (code or settings reach for it), `mentioned` (a manifest lists a driver). */
export type DependencyStrength = "declared" | "used" | "mentioned";

/** A flag on something Rovara will not do as written. Closed list: a flag is fixed words, never repository text. */
export const DEPENDENCY_REFUSED_FIELDS = ["privileged", "host_network", "host_pid", "host_ipc", "host_volume", "docker_socket", "cap_add", "devices", "build"] as const;
export type DependencyRefusedField = (typeof DEPENDENCY_REFUSED_FIELDS)[number];

export interface DependencyKeyAttribute { name: string; type: "S" | "N" | "B" }
export interface DependencyResource {
  kind: "table" | "bucket" | "queue" | "topic";
  /** The physical name when the code writes one as a plain identifier, else the template's own id for it. */
  name: string;
  keySchema?: { partitionKey: DependencyKeyAttribute; sortKey?: DependencyKeyAttribute };
}

/**
 * What a detector learned beyond the family. Every value here is a name, a number or a fixed word: a value from a file (a password, a token, a host) is never copied. `url` keeps a connection setting's scheme and
 * host FAMILY (`local`, `private`, `cloud`, `unknown`), never the host.
 */
export interface DependencyHints {
  /** The major version an image tag or manifest named (`16` for `postgres:16.4-alpine`). */
  version?: string;
  /** The names (not values) of the settings that point the code at it. */
  envNames?: string[];
  ports?: number[];
  hasHealthcheck?: boolean;
  /** Repository-relative files that seed it (an init script mounted into the image). */
  initFiles?: string[];
  /** Compose service names this one waits for. Names only. */
  dependsOn?: string[];
  /** Things Rovara would refuse to run as written (compose / CI / dev container). */
  refused?: DependencyRefusedField[];
  /** Code hard-codes an endpoint, bypassing the endpoint variables (owner Q1: settings only in v1). */
  explicitEndpoint?: boolean;
  /** The project's own tests already fake it in their process (`faked_by_tests`). */
  fakedByTests?: boolean;
  /** Testcontainers starts it in the tests (cannot run inside Rovara). */
  testcontainers?: boolean;
  /** The settings that name it parsed down to scheme and host family. */
  url?: { scheme: string; hostFamily: "local" | "private" | "cloud" | "unknown" };
  /** Resources infrastructure code declares (tables with their key schema, buckets, queues, topics), at most 24: what Rovara local AWS creates when it starts. */
  resources?: DependencyResource[];
  /** Which detector families saw it (`compose`, `ci`, `env`, `driver`, `sdk`, `test`, `iac`). */
  seenBy?: string[];
}

/** What every dependency detector (D1-D7) reports. Candidates with the same family merge into one (`mergeCandidates`). A person or the chooser still decides the backing; nothing here is a `TestEnvDependency`. */
export interface DependencyCandidate {
  /** A `FamilyId`: `postgres`, `redis`, `aws:s3`, `http:<host>`, ... */
  family: string;
  kind: TestEnvDependencyKind;
  /** Where it was seen: files and lines, at most 8 once merged. */
  evidence: DependencyEvidence[];
  strength: DependencyStrength;
  hints: DependencyHints;
}

export interface Detection {
  setupCommands: Array<Located<ProjectCommand>>;
  checks: Array<Located<DetectedCheck>>;
  services: Array<Located<DetectedService>>;
  iac: Array<Located<DetectedIac>>;
  /** Dependency candidates (test services D1-D7). Absent unless a detector found one, so a repository with none gives today's detection byte for byte. */
  dependencies?: DependencyCandidate[];
  /** Globs that change the meaning of every test (lockfiles, conftest, build and CI config). */
  fullSuiteOn: Array<Located<string>>;
  /** Plain statements for the maintainer: what was found that the proposal cannot use, and what is not known. Fixed words, never repository text. */
  notes: string[];
  /** Things only a person can answer. */
  questions: string[];
}

export const emptyDetection = (): Detection => ({ setupCommands: [], checks: [], services: [], iac: [], fullSuiteOn: [], notes: [], questions: [] });

/** The repository as a detector sees it: a bounded list of paths and a bounded reader. */
export interface RepositoryReader {
  /** Repository-relative POSIX paths, files only. */
  paths: readonly string[];
  /** True when the path list was cut at the limit: absence of a file from `paths` then proves nothing. */
  truncated?: boolean;
  /** True once the shared byte budget cut a file (a detector's absence of findings then proves nothing about the files it could not read). */
  budgetExhausted?(): boolean;
  /** The file's text, or undefined when it is missing, binary, unreadable or over the read limits. Never throws. */
  read(path: string): Promise<string | undefined>;
}

export interface DetectorContext {
  repo: RepositoryReader;
  /** The repository's directory in the workspace (the `cwd` of its commands). */
  cwd: string;
}

export type Detector = (context: DetectorContext) => Promise<Partial<Detection>>;

export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let at = text.indexOf("\n"); at !== -1 && at < index; at = text.indexOf("\n", at + 1)) line += 1;
  return line;
}

/** The first match's line, or undefined. */
export function findLine(text: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(text);
  return match === null ? undefined : lineOf(text, match.index);
}
