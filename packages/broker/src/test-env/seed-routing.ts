// Seed commands in a setup draft (TS-UX-1): the worker takes a command that fills or migrates a database OUT of the setup commands (setup has no database) and carries it in the draft as `seedCommands`. The BROKER
// decides where it lands: the seed of the first database dependency it proposes (real software or Rovara local AWS, never a fake), after the same refusals a seed always gets (`seedCommandProblem`: download-and-run,
// secrets, system variables, length). Nothing here approves anything: a seed command is a less-safe change (`dependency_seed`), so a second person still confirms it. Notes are fixed words, never the command.
import { TEST_ENV_DEPENDENCY_LIMITS, TestEnvDependenciesSchema, type TestEnvDependency, type TestEnvDraft } from "@agentx/contracts";
import { seedCommandProblem } from "./refused-command.js";

export const SEED_OFFERED_NOTE = "A command that fills the database was found. It is offered as the test database's seed, not as a setup command: setup has no database. A seed runs against the test database, so approving it needs a second person.";
export const SEED_NO_DATABASE_NOTE = "A command that fills the database was found, but no test database could be proposed for it, so it is not part of the proposal. Add the database first.";
export const SEED_REFUSED_NOTE = "A command that fills the database was left out: it downloads and runs code, holds something secret, or sets a variable the system owns.";

/** The dependencies with the draft's seed commands on the first database one, and the fixed notes for what happened. A list the contract would refuse is returned as it came. Never throws. */
export function attachDraftSeeds(dependencies: readonly TestEnvDependency[], seeds: TestEnvDraft["seedCommands"]): { dependencies: TestEnvDependency[]; notes: string[] } {
  if (seeds === undefined || seeds.length === 0) return { dependencies: [...dependencies], notes: [] };
  const notes: string[] = [];
  const allowed = seeds.filter((seed) => seedCommandProblem(seed.command) === undefined);
  if (allowed.length < seeds.length) notes.push(SEED_REFUSED_NOTE);
  if (allowed.length === 0) return { dependencies: [...dependencies], notes };
  const index = dependencies.findIndex((dependency) => dependency.kind === "database" && (dependency.backing.kind === "local" || dependency.backing.kind === "emulated"));
  if (index < 0) return { dependencies: [...dependencies], notes: [...notes, SEED_NO_DATABASE_NOTE] };
  const target = dependencies[index]!;
  const held = target.seeds.filter((seed) => !("command" in seed));
  const next: TestEnvDependency = { ...target, seeds: [...held, ...allowed.map((seed) => ({ command: seed.command }))].slice(0, TEST_ENV_DEPENDENCY_LIMITS.seeds) };
  const list = dependencies.map((dependency, at) => (at === index ? next : dependency));
  if (!TestEnvDependenciesSchema.safeParse(list).success) return { dependencies: [...dependencies], notes: [...notes, SEED_NO_DATABASE_NOTE] };
  return { dependencies: list, notes: [...notes, SEED_OFFERED_NOTE] };
}
