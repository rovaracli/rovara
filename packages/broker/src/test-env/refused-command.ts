// A command the broker will not carry in a draft, a proposal or a seed: it fetches code and runs it, or its text changes under the redactor (a secret-shaped value). A leaf module, so the places that need it (the
// draft, the edit check, the approval's refusal of unsafe dependency seeds) can share it without importing each other.
import { formatCommandLine, redactText, remoteCodeReason, type ProjectCommand, type TestEnvDependency } from "@agentx/contracts";

export function refusedCommand(command: ProjectCommand): boolean {
  const text = formatCommandLine(command);
  return remoteCodeReason(text) !== undefined || redactText(text) !== text;
}

/** The seed COMMANDS of a list of dependencies (a seed that is a repository file is not a command). */
export function dependencySeedCommands(dependencies: readonly Pick<TestEnvDependency, "seeds">[] | undefined): ProjectCommand[] {
  return (dependencies ?? []).flatMap((dependency) => dependency.seeds.flatMap((seed) => ("command" in seed ? [seed.command] : [])));
}
