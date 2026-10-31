// Brazil detector (build system of the first pilot). [I] Only the presence of a Brazil package is known here; how it runs tests (command, JUnit and coverage paths) has to come from the maintainer, so this detector
// proposes nothing and says so. It is one detector in a list: another build system adds another file here, not another shape.
import type { Detector } from "./types.js";

export const detectBrazil: Detector = async ({ repo, cwd }) => {
  void cwd;
  const config = repo.paths.includes("Config") ? await repo.read("Config") : undefined;
  if (config === undefined || !/\bpackage\.|\bbrazil\b|\bbuild-system\b|\bBuildSystem\b/iu.test(config)) return {};
  return {
    notes: ["A Brazil package file (Config) was found. Rovara does not guess how Brazil runs tests in your setup."],
    questions: ["How does your build system run the unit tests, and where does it write the JUnit and coverage reports?"],
  };
};
