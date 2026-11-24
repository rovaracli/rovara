/* eslint-disable @typescript-eslint/no-unsafe-member-access -- the tests build and break plain CloudFormation JSON at a path, which a typed document would not allow */
// NOT a CI test: it reads the research folder (only the RELEASE_ARTIFACTS env var; unset means skipped) and SKIPS when it is absent, on purpose: the real templates and change sets carry account data, so they are never copied into the repo. Run it locally.
// REAL saved change sets (lane P0 / the install folders): the evaluator is run on the saved DescribeChangeSet files, live templates, new templates and live parameters of the Code installs.
// Only the parts a preview does not hold (gates, CI, images, paths) are the routine fixtures'. Expected: no row, parameter, template or image reason for the 9 routine releases;
// for 0.5.48 exactly the four rows P0 named (DefaultStage RouteSettings and the three Adds). Absent folders skip. The real files carry the account id; the test reads it at run time and never stores it.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/evaluate.ts";
import { codeInput, imageEntry, type Obj } from "./fixtures.ts";

// Set RELEASE_ARTIFACTS to the release-artifacts folder to run this; unset, it is skipped with a message. No default path lives in this tree.
const ROOT = process.env.RELEASE_ARTIFACTS;
const PREVIEWS: [string, string, boolean][] = [
  ["install-20261123a/preview-code-cc06535d2-staging-20261123T005258Z", "0.5.39", true],
  ["install-20261123d/preview-code-8ff27bbf5-staging-20261123T040616Z", "0.5.42", true],
  ["install-20261123f/preview-code-a6d8a5cee-staging-20261123T151504Z", "0.5.44", true],
  ["install-20261123j/preview-code-8cbaf47cd-staging-20261123T164740Z", "0.5.45", true],
  ["install-20261123l/preview-code-1b87b06e8-staging-20261123T180445Z", "0.5.46", true],
  ["install-20261123n/preview-code-245bdad9e-staging-20261123T200101Z", "0.5.47", true],
  ["install-20261123o/preview-code-9517796fc-staging-20261123T211048Z", "0.5.48", false],
];

function realInput(dir: string): Obj {
  const names = readdirSync(dir).filter((f) => f.endsWith(".changeset.json")).map((f) => f.replace(".changeset.json", ""));
  const input = codeInput();
  const images: Obj[] = [];
  let account = "";
  input.stacks = names.map((n) => {
    const read = (suffix: string): Obj => JSON.parse(readFileSync(`${dir}/${n}.${suffix}.json`, "utf8")) as Obj;
    const cs = read("changeset");
    for (const p of cs.Parameters as Obj[]) {
      const m = /^(\d{12})\.dkr\.ecr\.us-west-2\.amazonaws\.com\/([^@]+)@(sha256:[0-9a-f]{64})$/.exec((p.ParameterValue as string | undefined) ?? "");
      if (m !== null) { account = m[1] as string; images.push(imageEntry(m[2] as string, m[3] as string)); }
    }
    return { stackName: n, changeSet: cs, liveTemplate: read("live-template"), newTemplate: read("template"), liveParameters: read("live-params") };
  });
  input.environment.accountId = account === "" ? "111111111111" : account;
  input.images = images;
  input.answers = { lastGood: "{}", current: "{}" };
  input.overrides = { lastGood: "{}", current: "{}" };
  return input;
}

describe("real saved Code previews", () => {
  for (const [rel, label, routine] of PREVIEWS) {
    const dir = `${ROOT ?? ""}/${rel}`;
    it(`${label}: ${routine ? "no row, parameter or template reason" : "exactly the rows P0 named"}`, () => {
      if (ROOT === undefined) { console.warn("real-previews: RELEASE_ARTIFACTS is not set; skipped"); return; }
      if (!existsSync(dir)) throw new Error(`RELEASE_ARTIFACTS is set but ${dir} is missing`);
      const d = evaluate(realInput(dir));
      const structural = d.reasons.filter((r) => ["E", "F", "G", "H", "I"].includes(r.rule));
      if (routine) expect(structural).toEqual([]);
      else {
        const text = structural.map((r) => r.message).join("\n");
        expect(structural).toHaveLength(4);
        for (const id of ["DefaultStage", "GithubWebhookSecret", "GithubWebhookSecretPolicy", "GithubWebhookRejectedAlarm"]) expect(text).toContain(id);
      }
      expect(d.rows.length).toBeGreaterThan(300);
    });
  }
});
