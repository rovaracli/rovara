// Environment detectors (E2, design proof-test-env section 4.1): CODE reads the repository first and says what it found, with where (file and line) or which detector. The read-only setup agent then fills only the gaps.
// Detectors are pure over a bounded reader: they never run a command and never read outside the file list they are given.
import type { CheckKind, ProjectCommand } from "@agentx/contracts";

/** Where a detected value came from: a file and line, or a detector's name. */
export type DetectedSource = { path: string; line: number } | `detector:${string}`;

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
  selectArgs?: string[];
}

export type DetectedServiceKind = "sagemaker_runtime" | "http";
export interface DetectedService {
  kind: DetectedServiceKind;
  /** The endpoint name (SageMaker) or the host (http). A SageMaker client with no literal endpoint name is reported as a question instead. */
  target: string;
}

export interface DetectedIac { provider: "cdk" | "cloudformation" | "terraform"; path: string }

export interface Detection {
  setupCommands: Array<Located<ProjectCommand>>;
  checks: Array<Located<DetectedCheck>>;
  services: Array<Located<DetectedService>>;
  iac: Array<Located<DetectedIac>>;
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
