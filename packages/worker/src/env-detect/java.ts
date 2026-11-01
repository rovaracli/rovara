// Java detector: Maven (pom.xml, mvnw) and Gradle (build.gradle[.kts], settings.gradle[.kts], gradlew). Generic: nothing here is specific to one customer or one build host.
// Commands prefer the project's own wrapper (only when its properties file is there too, or the wrapper cannot run). Report and coverage locations come from the build's own configuration (cited with file and line)
// or from the tool's default (cited as `detector:java`); JaCoCo coverage is proposed only when the build writes the XML report. Only the top-level build files are read, so a plugin applied only inside a module is not
// seen. A multi-module build gets root-level commands and a module list but no single report path (each module writes its own). Maven and Gradle together at the top is a question, not a guess.
// No per-test selection is proposed: both tools take one pattern per flag, which the `{tests}` template (one place, separate arguments) cannot express safely, and Rovara never rewrites the customer's command.
import { type Detection, type DetectedSource, type Detector, type DetectorContext, findLine, lineOf } from "./types.js";

const TIMEOUT = { test: 1_800, integration: 3_600, lint: 600, setup: 900 } as const;
const MAX_MODULES = 20;
const MAVEN_PHASES = ["validate", "initialize", "generate-sources", "process-sources", "generate-resources", "process-resources", "compile", "process-classes", "generate-test-sources", "process-test-sources", "generate-test-resources", "process-test-resources", "test-compile", "process-test-classes", "test", "prepare-package", "package", "pre-integration-test", "integration-test", "post-integration-test", "verify", "install", "deploy"];
const TEST_SOURCE = /(?:^|\/)src\/(?:test|integrationTest|intTest)\/(?:java|kotlin|groovy|scala)\//u;
const SAFE_DIR = /^[A-Za-z0-9_./-]{1,200}$/u;
const GRADLE_BUILD_FILES = ["build.gradle", "build.gradle.kts"] as const;
const GRADLE_SETTINGS_FILES = ["settings.gradle", "settings.gradle.kts"] as const;

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** Replaces the matched text with spaces, keeping every newline, so a line number found afterwards is still the file's. */
const blank = (text: string, pattern: RegExp): string => text.replace(pattern, (match) => match.replace(/[^\n]/gu, " "));
const safeRelative = (value: string): string | undefined => (SAFE_DIR.test(value) && !value.startsWith("/") && !value.split("/").some((part) => part === "" || part === "." || part === "..") ? value : undefined);
const cmd = (cwd: string, executable: string, args: string[], timeoutSeconds: number) => ({ cwd, executable, args, timeoutSeconds });
const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? "" : "s"}`;

function moduleNote(modules: string[]): string {
  const shown = modules.slice(0, MAX_MODULES).join(", ");
  const more = modules.length > MAX_MODULES ? ` and ${String(modules.length - MAX_MODULES)} more` : "";
  return `The build has ${plural(modules.length, "module")}: ${shown}${more}. Each module writes its own test and coverage reports, so one report path cannot cover them; counts come from the exit code until a maintainer sets a report path.`;
}

function javaVersionNote(path: string, text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  const version = match?.slice(1).find((part) => part !== undefined);
  return match === null || version === undefined ? undefined : `The build asks for Java ${version.replace("_", ".")} (${path} line ${String(lineOf(text, match.index))}); the test environment must provide it.`;
}

type Found = Partial<Detection> & { setupCommands: NonNullable<Detection["setupCommands"]>; checks: NonNullable<Detection["checks"]>; fullSuiteOn: NonNullable<Detection["fullSuiteOn"]>; notes: string[] };

function selectionNote(): string {
  return "Rovara proposes no per-test selection for Maven or Gradle (their test filters take one pattern per flag, which the selection template cannot express safely), so every run is the whole suite.";
}

/** The wrapper downloads its build tool from the URL in its properties file; a host other than the tools' own is named so a person sees where code will come from. */
const WRAPPER_HOSTS = new Set(["services.gradle.org", "repo.maven.apache.org"]);
async function wrapperSourceNotes(repo: DetectorContext["repo"], path: string, tool: string): Promise<string[]> {
  const text = await repo.read(path);
  if (text === undefined) return [];
  const notes: string[] = [];
  for (const match of text.matchAll(/^[ \t]*(distributionUrl|wrapperUrl)[ \t]*[=:][ \t]*(\S+)/gmu)) {
    const host = /^https?:\/\/(?:[^/@\s]*@)?([A-Za-z0-9.-]{1,253})(?::\d{1,5})?(?:[/\s]|$)/u.exec(match[2]!.replace(/\\(.)/gu, "$1"))?.[1]?.toLowerCase();
    const where = `${path} line ${String(lineOf(text, match.index))}`;
    if (host === undefined) notes.push(`The ${tool} wrapper's ${match[1]!} (${where}) could not be read as a web address, so where it downloads ${tool} from is not known.`);
    else if (!WRAPPER_HOSTS.has(host)) notes.push(`The ${tool} wrapper downloads ${tool} from ${host} (${where}), not from the usual source; confirm that is a source you trust.`);
  }
  return notes;
}

// ---- Maven

interface PluginBlock { body: string; index: number; line: number }
/** The first `<plugin>` whose artifactId is `artifactId`; `line` is the artifactId's line. */
function mavenPlugin(text: string, artifactId: string): PluginBlock | undefined {
  const id = new RegExp(`<artifactId>\\s*${escape(artifactId)}\\s*</artifactId>`, "u");
  for (const match of text.matchAll(/<plugin>[\s\S]*?<\/plugin>/gu)) {
    const inner = id.exec(match[0]);
    if (inner !== null) return { body: match[0], index: match.index, line: lineOf(text, match.index + inner.index) };
  }
  return undefined;
}

/** A reports directory written in the pom, as a safe path relative to the module, or undefined when it needs a property or leaves the module. */
function mavenDirectory(value: string): string | undefined {
  const trimmed = value.trim().replace(/\/+$/u, "");
  const resolved = /^\$\{project\.build\.directory\}(?:\/|$)/u.test(trimmed) ? trimmed.replace(/^\$\{project\.build\.directory\}/u, "target") : /^\$\{(?:basedir|project\.basedir)\}\//u.test(trimmed) ? trimmed.replace(/^\$\{(?:basedir|project\.basedir)\}\//u, "") : trimmed;
  return resolved.includes("$") ? undefined : safeRelative(resolved);
}

const MAVEN_LINT = [
  { id: "checkstyle", label: "Lint (Checkstyle)", artifact: "maven-checkstyle-plugin", goals: ["checkstyle:check"] },
  { id: "spotbugs", label: "Static analysis (SpotBugs)", artifact: "spotbugs-maven-plugin", goals: ["compile", "spotbugs:check"] },
  { id: "pmd", label: "Static analysis (PMD)", artifact: "maven-pmd-plugin", goals: ["pmd:check"] },
  { id: "spotless", label: "Format check (Spotless)", artifact: "spotless-maven-plugin", goals: ["spotless:check"] },
] as const;

async function detectMaven(context: DetectorContext, hasTests: boolean): Promise<Partial<Detection>> {
  const { repo, cwd } = context;
  const raw = await repo.read("pom.xml");
  if (raw === undefined) return { notes: ["pom.xml could not be read."] };
  const pom = blank(raw, /<!--[\s\S]*?-->/gu);
  const withoutProfiles = blank(pom, /<profiles>[\s\S]*?<\/profiles>/gu);
  // A plugin counts as part of the build only outside pluginManagement and profiles (a profile needs a flag Rovara does not know); its configuration may also sit in pluginManagement.
  const active = blank(withoutProfiles, /<pluginManagement>[\s\S]*?<\/pluginManagement>/gu);
  const notes: string[] = [];
  const hasWrapper = repo.paths.includes("mvnw") && repo.paths.includes(".mvn/wrapper/maven-wrapper.properties");
  if (repo.paths.includes("mvnw") && !hasWrapper) notes.push("A Maven wrapper script (mvnw) was found without .mvn/wrapper/maven-wrapper.properties, so it cannot run; the commands use mvn.");
  if (hasWrapper) notes.push(...(await wrapperSourceNotes(repo, ".mvn/wrapper/maven-wrapper.properties", "Maven")));
  const executable = hasWrapper ? "./mvnw" : "mvn";
  const run = (goals: string[], timeoutSeconds: number) => cmd(cwd, executable, ["-B", ...goals], timeoutSeconds);
  const top = findLine(pom, /<project[\s>]/u) ?? 1;
  const projectAt: DetectedSource = { path: "pom.xml", line: top };

  const modulesBlock = /<modules>([\s\S]*?)<\/modules>/u.exec(active)?.[1] ?? "";
  const modules = [...modulesBlock.matchAll(/<module>\s*([^<\s][^<]*?)\s*<\/module>/gu)].map((match) => match[1]!).filter((name) => /^[A-Za-z0-9_./-]{1,100}$/u.test(name));
  const multi = modules.length > 0;
  if (multi) notes.push(moduleNote(modules));
  const versionNote = javaVersionNote("pom.xml", pom, /<(?:maven\.compiler\.release|maven\.compiler\.source|java\.version|release)>\s*(\d{1,2}(?:\.\d{1,2})?)\s*</u);
  if (versionNote !== undefined) notes.push(versionNote);

  const fullSuiteOn: Array<{ value: string; source: DetectedSource }> = [{ value: "pom.xml", source: "detector:java" }];
  if (repo.paths.includes("mvnw")) fullSuiteOn.push({ value: "mvnw", source: "detector:java" });
  if (repo.paths.some((path) => path.startsWith(".mvn/"))) fullSuiteOn.push({ value: ".mvn/**", source: "detector:java" });
  if (multi || repo.paths.some((path) => path.endsWith("/pom.xml"))) fullSuiteOn.push({ value: "**/pom.xml", source: "detector:java" });

  const found: Found = { setupCommands: [{ value: run(["test-compile"], TIMEOUT.setup), source: projectAt }], checks: [], fullSuiteOn, notes };
  if (!hasTests) {
    notes.push("No Java test sources were found, so no test command is proposed.");
    return found;
  }

  // JaCoCo: coverage only when the build binds the report goal (its phase decides which Maven phase the check has to reach).
  const jacoco = mavenPlugin(active, "jacoco-maven-plugin");
  let coverage: { path: string; source: DetectedSource; phase: number } | undefined;
  if (jacoco !== undefined) {
    const execution = [...jacoco.body.matchAll(/<execution>[\s\S]*?<\/execution>/gu)].find((item) => /<goal>\s*report\s*<\/goal>/u.test(item[0]));
    const goalAt = /<goal>\s*report\s*<\/goal>/u.exec(jacoco.body);
    if (execution === undefined || goalAt === null) notes.push("JaCoCo is configured but the build does not write an XML report in a normal build, so changed-line coverage will show as not measured.");
    else if (multi) notes.push("JaCoCo writes one report per module, so no coverage path is proposed.");
    else {
      const phase = /<phase>\s*([a-z-]+)\s*<\/phase>/u.exec(execution[0])?.[1] ?? "verify";
      const index = MAVEN_PHASES.indexOf(phase);
      const dir = mavenDirectory(/<outputDirectory>([^<]{1,200})<\/outputDirectory>/u.exec(jacoco.body)?.[1] ?? "") ?? "target/site/jacoco";
      if (index === -1 || index > MAVEN_PHASES.indexOf("verify")) notes.push("JaCoCo's report is bound to a phase after verify, so no coverage path is proposed.");
      else coverage = { path: `${dir}/jacoco.xml`, source: { path: "pom.xml", line: lineOf(pom, jacoco.index + goalAt.index) }, phase: index };
    }
  }

  // Test reports: Surefire (unit) and Failsafe (integration). The pom's own reportsDirectory wins over the tool default.
  const surefire = mavenPlugin(withoutProfiles, "maven-surefire-plugin");
  const failsafe = mavenPlugin(active, "maven-failsafe-plugin");
  const reportDirectory = (block: PluginBlock | undefined, fallback: string): { path: string; source: DetectedSource } => {
    if (block !== undefined) {
      const match = /<reportsDirectory>([^<]{1,200})<\/reportsDirectory>/u.exec(block.body);
      const dir = match === null ? undefined : mavenDirectory(match[1]!);
      if (match !== null && dir !== undefined) return { path: dir, source: { path: "pom.xml", line: lineOf(pom, block.index + match.index) } };
    }
    return { path: fallback, source: "detector:java" };
  };
  const unitReport = reportDirectory(surefire, "target/surefire-reports");
  const unitReachesCoverage = coverage !== undefined && coverage.phase <= MAVEN_PHASES.indexOf("test");
  // Without Failsafe the one test check has to reach the phase the coverage report is bound to.
  const unitGoal = coverage !== undefined && failsafe === undefined && !unitReachesCoverage ? "verify" : "test";
  found.checks.push({
    value: {
      id: "unit", label: "Unit tests (Maven)", kind: "test", command: run([unitGoal], TIMEOUT.test),
      ...(multi ? {} : { reportPath: unitReport.path, reportSource: unitReport.source }),
      ...(!multi && coverage !== undefined && (unitReachesCoverage || (failsafe === undefined && unitGoal === "verify")) ? { coveragePath: coverage.path, coverageSource: coverage.source } : {}),
    },
    source: surefire === undefined ? projectAt : { path: "pom.xml", line: surefire.line },
  });
  if (failsafe !== undefined) {
    const integrationReport = reportDirectory(failsafe, "target/failsafe-reports");
    found.checks.push({
      value: {
        id: "integration", label: "Integration tests (Maven)", kind: "test", command: run(["verify"], TIMEOUT.integration),
        ...(multi ? {} : { reportPath: integrationReport.path, reportSource: integrationReport.source }),
        ...(!multi && coverage !== undefined && !unitReachesCoverage ? { coveragePath: coverage.path, coverageSource: coverage.source } : {}),
      },
      source: { path: "pom.xml", line: failsafe.line },
    });
    notes.push("The integration check runs verify, which runs the unit tests again before the integration tests.");
  }
  if (!multi) notes.push(`JUnit XML reports are expected in ${unitReport.path}${unitReport.source === "detector:java" ? " (Maven Surefire's default location)" : " (set in the pom)"}; the Prove run checks that they are written.`);
  for (const tool of MAVEN_LINT) {
    const block = mavenPlugin(active, tool.artifact);
    if (block !== undefined) found.checks.push({ value: { id: tool.id, label: tool.label, kind: "lint", command: run([...tool.goals], TIMEOUT.lint) }, source: { path: "pom.xml", line: block.line } });
  }
  notes.push(selectionNote());
  return found;
}

// ---- Gradle

/** The line of a plugin applied in any of the usual ways (`id 'x'`, `id("x")`, `apply plugin: 'x'`, a bare name in a plugins block), or undefined. */
function gradlePluginLine(text: string, ...ids: string[]): number | undefined {
  for (const id of ids) {
    const pattern = new RegExp(String.raw`(?:\bid\s*\(?\s*|\bapply\s+plugin\s*:\s*|^[ \t]*)["'` + "`" + String.raw`]?${escape(id)}["'` + "`" + String.raw`]?(?=\s*(?:\)|$|version\b|apply\b))`, "mu");
    const line = findLine(text, pattern);
    if (line !== undefined) return line;
  }
  return undefined;
}

const GRADLE_LINT = [
  { id: "checkstyle", label: "Lint (Checkstyle)", plugins: ["checkstyle"], tasks: ["checkstyleMain", "checkstyleTest"] },
  { id: "spotbugs", label: "Static analysis (SpotBugs)", plugins: ["com.github.spotbugs"], tasks: ["spotbugsMain", "spotbugsTest"] },
  { id: "pmd", label: "Static analysis (PMD)", plugins: ["pmd"], tasks: ["pmdMain", "pmdTest"] },
  { id: "spotless", label: "Format check (Spotless)", plugins: ["com.diffplug.spotless", "spotless"], tasks: ["spotlessCheck"] },
] as const;

async function detectGradle(context: DetectorContext, hasTests: boolean): Promise<Partial<Detection>> {
  const { repo, cwd } = context;
  const buildName = GRADLE_BUILD_FILES.find((name) => repo.paths.includes(name));
  const settingsName = GRADLE_SETTINGS_FILES.find((name) => repo.paths.includes(name));
  const clean = (text: string): string => blank(blank(text, /\/\*[\s\S]*?\*\//gu), /(^|[ \t])\/\/[^\n]*/gmu);
  const buildRaw = buildName === undefined ? "" : await repo.read(buildName);
  const settingsRaw = settingsName === undefined ? "" : await repo.read(settingsName);
  if (buildRaw === undefined || settingsRaw === undefined) return { notes: [`${buildRaw === undefined ? (buildName ?? "The Gradle build file") : (settingsName ?? "The Gradle settings file")} could not be read.`] };
  const build = clean(buildRaw);
  const settings = clean(settingsRaw);
  const notes: string[] = [];
  const hasWrapper = repo.paths.includes("gradlew") && repo.paths.includes("gradle/wrapper/gradle-wrapper.properties") && repo.paths.includes("gradle/wrapper/gradle-wrapper.jar");
  if (repo.paths.includes("gradlew") && !hasWrapper) notes.push("A Gradle wrapper script (gradlew) was found without gradle/wrapper/gradle-wrapper.properties and gradle/wrapper/gradle-wrapper.jar, so it cannot run; the commands use gradle.");
  if (hasWrapper) notes.push(...(await wrapperSourceNotes(repo, "gradle/wrapper/gradle-wrapper.properties", "Gradle")));
  const executable = hasWrapper ? "./gradlew" : "gradle";
  const run = (tasks: string[], timeoutSeconds: number) => cmd(cwd, executable, ["--console=plain", ...tasks], timeoutSeconds);
  const buildPath = buildName ?? settingsName ?? "build.gradle";
  const topLine = findLine(build, /^\s*(?:plugins\s*\{|apply\s+plugin)/mu) ?? 1;
  const topAt: DetectedSource = { path: buildPath, line: topLine };

  const modules: string[] = [];
  for (const match of settings.matchAll(/\binclude\s*\(?\s*((?:["'][^"'\n]{1,100}["']\s*,?\s*)+)/gu)) {
    for (const item of match[1]!.matchAll(/["']([^"'\n]{1,100})["']/gu)) {
      const name = item[1]!.replace(/^:/u, "");
      if (/^[A-Za-z0-9_.:/-]{1,100}$/u.test(name) && !modules.includes(name)) modules.push(name);
    }
  }
  const multi = modules.length > 0;
  if (multi) notes.push(moduleNote(modules));
  const versionNote = buildName === undefined ? undefined : javaVersionNote(buildName, build, /JavaLanguageVersion\.of\(\s*(\d{1,2})\s*\)|JavaVersion\.VERSION_(\d{1,2}(?:_\d{1,2})?)|\bsourceCompatibility\s*=?\s*['"]?(\d{1,2}(?:\.\d{1,2})?)/u);
  if (versionNote !== undefined) notes.push(versionNote);

  const fullSuiteOn: Array<{ value: string; source: DetectedSource }> = [];
  for (const name of [...GRADLE_BUILD_FILES, ...GRADLE_SETTINGS_FILES, "gradle.properties", "gradle.lockfile", "gradle/libs.versions.toml", "gradle/wrapper/gradle-wrapper.properties", "gradlew"]) if (repo.paths.includes(name)) fullSuiteOn.push({ value: name, source: "detector:java" });
  for (const dir of ["buildSrc", "build-logic", "gradle/dependency-locks"]) if (repo.paths.some((path) => path.startsWith(`${dir}/`))) fullSuiteOn.push({ value: `${dir}/**`, source: "detector:java" });
  for (const name of GRADLE_BUILD_FILES) if (multi || repo.paths.some((path) => path.endsWith(`/${name}`))) fullSuiteOn.push({ value: `**/${name}`, source: "detector:java" });

  const found: Found = { setupCommands: [{ value: run(["testClasses"], TIMEOUT.setup), source: topAt }], checks: [], fullSuiteOn, notes };
  if (!hasTests) {
    notes.push("No Java test sources were found, so no test command is proposed.");
    return found;
  }

  // JaCoCo: coverage only when the build enables the XML report; the report task is added to the command unless the build already runs it after the tests.
  let coverage: { path: string; source: DetectedSource; extraTask: boolean } | undefined;
  if (gradlePluginLine(build, "jacoco") !== undefined) {
    const xml = /xml\.required(?:\.set)?\s*(?:=|\()\s*true|xml\.enabled\s*(?:=\s*)?true|xml\s*\{[^}]*required\s*(?:=|\.set\()\s*true/u.exec(build);
    if (xml === null) notes.push("JaCoCo is configured but the build does not write an XML report, so changed-line coverage will show as not measured.");
    else if (multi) notes.push("JaCoCo writes one report per module, so no coverage path is proposed.");
    else coverage = { path: "build/reports/jacoco/test/jacocoTestReport.xml", source: { path: buildPath, line: lineOf(build, xml.index) }, extraTask: !/finalizedBy[^\n]*jacocoTestReport/u.test(build) };
  }
  const ownLocation = /junitXml|testResultsDir/u.test(build);
  if (ownLocation) notes.push("The build sets its own test result location, which Rovara does not read; no report path is proposed until a maintainer sets one.");
  const report = !multi && !ownLocation;
  found.checks.push({
    value: {
      id: "unit", label: "Unit tests (Gradle)", kind: "test", command: run(["test", ...(coverage?.extraTask === true ? ["jacocoTestReport"] : [])], TIMEOUT.test),
      ...(report ? { reportPath: "build/test-results/test", reportSource: "detector:java" as const } : {}),
      ...(coverage === undefined ? {} : { coveragePath: coverage.path, coverageSource: coverage.source }),
    },
    source: topAt,
  });
  const integration = /(?:register|create)\s*(?:<[^>]*>)?\s*\(\s*["'](integrationTest|intTest|functionalTest|componentTest)["']|\btask\s*\(?\s*["']?(integrationTest|intTest|functionalTest|componentTest)\b/u.exec(build);
  const integrationName = integration?.[1] ?? integration?.[2];
  if (integration !== null && integrationName !== undefined) {
    found.checks.push({
      value: {
        id: "integration", label: "Integration tests (Gradle)", kind: "test", command: run([integrationName], TIMEOUT.integration),
        ...(report ? { reportPath: `build/test-results/${integrationName}`, reportSource: { path: buildPath, line: lineOf(build, integration.index) } } : {}),
      },
      source: { path: buildPath, line: lineOf(build, integration.index) },
    });
  }
  if (report) notes.push("JUnit XML reports are expected in build/test-results/test (Gradle's default location); the Prove run checks that they are written.");
  for (const tool of GRADLE_LINT) {
    const line = gradlePluginLine(build, ...tool.plugins);
    if (line !== undefined) found.checks.push({ value: { id: tool.id, label: tool.label, kind: "lint", command: run([...tool.tasks], TIMEOUT.lint) }, source: { path: buildPath, line } });
  }
  notes.push(selectionNote());
  return found;
}

export const detectJava: Detector = async (context) => {
  const { repo } = context;
  const hasMaven = repo.paths.includes("pom.xml");
  const hasGradle = [...GRADLE_BUILD_FILES, ...GRADLE_SETTINGS_FILES].some((name) => repo.paths.includes(name));
  if (!hasMaven && !hasGradle) {
    const nested = repo.paths.filter((path) => /\/(?:pom\.xml|build\.gradle|build\.gradle\.kts|settings\.gradle|settings\.gradle\.kts)$/u.test(path));
    if (nested.length === 0 || !repo.paths.some((path) => TEST_SOURCE.test(path) || /\.(?:java|kt)$/u.test(path))) return {};
    return {
      notes: ["Java build files were found only in subfolders, not at the top of the repository, so no Java command is proposed."],
      questions: ["Which folder is the Java build run from (Maven or Gradle)? Its files are in a subfolder, not at the top of the repository."],
    };
  }
  if (hasMaven && hasGradle) {
    return {
      notes: ["Both Maven and Gradle build files were found at the top of the repository, so no Java command is proposed."],
      questions: ["This repository has both Maven (pom.xml) and Gradle (build.gradle or settings.gradle) files. Which one builds and tests it?"],
    };
  }
  const hasTests = repo.paths.some((path) => TEST_SOURCE.test(path) || /(?:^|\/)[A-Za-z0-9_]*Tests?\.(?:java|kt|groovy|scala)$/u.test(path));
  return hasMaven ? detectMaven(context, hasTests) : detectGradle(context, hasTests);
};
