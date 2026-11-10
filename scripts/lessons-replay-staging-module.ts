// Lessons replay (lane 7): the operator module for a real staging run, ready to pass as `--module`. It wires the replay's ports to the install through the `agentx` CLI (the administrator's own sign-in):
//   executor  `stagingExecutor` over `cliReplayPort`: copies of the past tasks, marked, billed to the project, the plan approved by the install's guarded route
//   grader    `rubricGrader` over the company's own model (`cliGraderModel`) and the copy's evidence (`cliEvidenceReader`)
//   builders  pipeline `current` offline (`offlinePipelineBuilder`: the current reflector and curator over the same past tasks, through the install's subject and model routes); `consolidated` refuses (lane 8)
//   importSnapshot  the lessons of an arm and a day, imported as a frozen snapshot
// Settings come from the environment (no secret among them): LESSONS_REPLAY_ENV (the CLI environment name), LESSONS_REPLAY_ORG (the company id), LESSONS_REPLAY_PROJECT, LESSONS_REPLAY_PER_RUN_USD (what one copy may
// spend once its plan is approved), LESSONS_REPLAY_PLANNING_LIMIT_USD (what planning may spend first: the project's planning limit), LESSONS_REPLAY_GRADER_MODEL and _VERSION (the grader's label, fixed for the whole replay), LESSONS_REPLAY_GRADE_HOLD_USD (the most one grading may cost), LESSONS_REPLAY_LEARN_HOLD_USD (the most one call
// of the offline pipeline may cost). Run it through ~/.local/share/rovara-tools/staging-aws.sh.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stagingExecutor } from "../packages/broker/src/lessons/replay-executor.js";
import { rubricGrader } from "../packages/broker/src/lessons/replay-grader.js";
import { consolidatedBuilderStub, offlinePipelineBuilder } from "../packages/broker/src/lessons/replay-offline.js";
import type { Lesson } from "../packages/broker/src/lessons/types.js";
import { cliEvidenceReader, cliGraderModel, cliPipelineModel, cliProjectSettings, cliReplayPort, cliSubjectOf, importSnapshot, realCliPortOptions } from "./lessons-replay-port.js";
import { gitCode, parseRepoDirs } from "./lessons-replay-git.js";
import type { OperatorModule } from "./lessons-replay-measure.js";

const need = (name: string): string => { const value = process.env[name]; if (value === undefined || value === "") throw new Error(`${name} is required`); return value; };
const num = (name: string): number => { const value = Number(need(name)); if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`); return value; };

export default function make(): OperatorModule {
  const env = need("LESSONS_REPLAY_ENV"), org = need("LESSONS_REPLAY_ORG"), project = need("LESSONS_REPLAY_PROJECT");
  const planningLimitUsd = Number(need("LESSONS_REPLAY_PLANNING_LIMIT_USD"));
  if (!Number.isFinite(planningLimitUsd) || planningLimitUsd < 0) throw new Error("LESSONS_REPLAY_PLANNING_LIMIT_USD must be the project's planning limit in dollars (zero or more)");
  const perRunUsd = num("LESSONS_REPLAY_PER_RUN_USD"), gradeHold = num("LESSONS_REPLAY_GRADE_HOLD_USD"), learnHold = num("LESSONS_REPLAY_LEARN_HOLD_USD");
  const options = realCliPortOptions({ env, repoRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "..") });
  // The offline pipeline runs under the project's REAL learning settings, read through the install. An install with an embedder merges similar lessons in a way this offline run cannot reproduce: stop unless the operator accepts that.
  const rules = cliProjectSettings(options, project);
  if (rules.embedder && process.env["LESSONS_REPLAY_ALLOW_NO_EMBEDDER"] !== "1") throw new Error("the install has a lessons embedder, which the offline pipeline cannot run, so similarity merging would differ from live; set LESSONS_REPLAY_ALLOW_NO_EMBEDDER=1 to accept that and have it reported");
  // The citation check runs over the operator's clones at the cited commit; without them citations are unverified (so no lesson can go live on trial), which makes the arm weaker than live.
  const repoDirsText = process.env["LESSONS_REPLAY_REPO_DIRS"] ?? "";
  if (repoDirsText === "" && process.env["LESSONS_REPLAY_NO_CITATION_CHECK"] !== "1") throw new Error("LESSONS_REPLAY_REPO_DIRS (name=directory of a clone of each repository) is required so citations are checked as live does; set LESSONS_REPLAY_NO_CITATION_CHECK=1 to run with citations unchecked");
  const repositories = (process.env["LESSONS_REPLAY_REPOSITORIES"] ?? "").split(",").filter((r) => r !== "");
  const code = repoDirsText === "" ? undefined : gitCode(parseRepoDirs(repoDirsText), repositories);
  const grader = rubricGrader({
    model: cliGraderModel(options, { project, model: need("LESSONS_REPLAY_GRADER_MODEL"), version: need("LESSONS_REPLAY_GRADER_VERSION"), holdUsd: gradeHold }),
    evidence: cliEvidenceReader(options),
    // The text of a historical correction, for the grader to judge a repeat by: supplied by the run's corrections file through the script (see `run`).
    correctionText: (id) => correctionTexts.get(id),
  });
  return {
    perRunUsd, planningLimitUsd,
    executor: stagingExecutor(cliReplayPort(options), { maxUsdPerRun: perRunUsd, planningLimitUsd }),
    grader,
    builders: {
      current: offlinePipelineBuilder({ key: { workspaceId: org, project }, subjectOf: cliSubjectOf(options, project), model: cliPipelineModel(options, { project, holdUsd: learnHold }), repositories, settings: { read: async () => rules.settings }, autoApply: rules.autoApply, installHasEmbedder: rules.embedder, ...(code === undefined ? {} : { code }) }),
      consolidated: consolidatedBuilderStub,
    },
    importSnapshot: (pipeline: string, day: string, lessons: readonly Lesson[]) => importSnapshot(options, { project, pipeline, day, lessons }),
    setCorrectionTexts: (texts) => { for (const [id, text] of texts) correctionTexts.set(id, text); },
  };
}
const correctionTexts = new Map<string, string>();
