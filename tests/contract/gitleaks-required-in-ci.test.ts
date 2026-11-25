// CI must have gitleaks, so the real-gitleaks tests of the secret-scan gate never skip silently there: a missing gitleaks fails the run, and the test job installs the pinned version.
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { gitleaksPlan, inCi } from "../support/gitleaks-required.ts";

type Step = { name?: string; uses?: string; with?: Record<string, string>; run?: string };
type Job = { needs?: string | string[]; if?: string; steps: Step[] };
const workflow = (): { env?: Record<string, string>; jobs: Record<string, Job> } => YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as { env?: Record<string, string>; jobs: Record<string, Job> };

describe("gitleaks is required in CI", () => {
  it("a missing gitleaks fails in CI and skips (loudly) locally; a present one runs", () => {
    expect(gitleaksPlan(true, {})).toBe("run");
    expect(gitleaksPlan(true, { CI: "true" })).toBe("run");
    expect(gitleaksPlan(false, { CI: "true" })).toBe("fail");
    expect(gitleaksPlan(false, { GITHUB_ACTIONS: "true" })).toBe("fail");
    expect(gitleaksPlan(false, { CI: "1" })).toBe("fail");
    expect(gitleaksPlan(false, {})).toBe("skip");
    for (const off of ["", "0", "false", "FALSE"]) expect(inCi({ CI: off }), off).toBe(false);
  });

  it("the gitleaks job downloads the pinned archive once per run, and the shards restore, re-check and install it", () => {
    const wf = workflow();
    // read as text: importing infra/lib/cloud-release-actions.ts needs the built packages
    const pinned = /GITLEAKS_VERSION: "([0-9.]+)"/u.exec(readFileSync("infra/lib/cloud-release-actions.ts", "utf8"))?.[1];
    expect(pinned).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/u);
    expect(wf.env?.GITLEAKS_VERSION).toBe(pinned);
    expect(wf.env?.GITLEAKS_SHA256).toMatch(/^[0-9a-f]{64}$/u);
    const KEY = "gitleaks-linux-x64-${{ env.GITLEAKS_VERSION }}-${{ env.GITLEAKS_SHA256 }}";
    // one download, in its own job, cached under a key that names the version and the hash
    const setup = wf.jobs.gitleaks!;
    expect(setup.needs).toBe("scope");
    expect(setup.if).toBe("needs.scope.outputs.docs_only != 'true'");
    const cache = setup.steps.find((step) => step.uses?.startsWith("actions/cache@"));
    expect(cache?.with?.key).toBe(KEY);
    const download = setup.steps.find((step) => /Download gitleaks/u.test(step.name ?? ""))!;
    expect(download.run).toContain("linux_x64.tar.gz");
    expect(download.run).toContain("sha256sum -c -");
    expect(download.run).toContain("${GITLEAKS_SHA256}");
    // the shards wait for it, restore the same key (same pinned action commit), check the hash again, and run it before the tests
    const test = wf.jobs.test!;
    expect(test.needs).toEqual(["scope", "checks", "gitleaks"]);
    expect(wf.jobs.local!.needs).toContain("gitleaks");
    const steps = test.steps;
    const restore = steps.find((step) => step.uses?.startsWith("actions/cache/restore@"));
    expect(restore?.with?.key).toBe(KEY);
    expect(restore?.with?.path).toBe(cache?.with?.path);
    expect(restore?.uses?.split("@")[1]).toBe(cache?.uses?.split("@")[1]);
    const install = steps.find((step) => /Install gitleaks/u.test(step.name ?? ""));
    expect(install, "the test job has no gitleaks install step").toBeDefined();
    expect(install!.run).toContain("sha256sum -c -");
    expect(install!.run).toContain("$GITHUB_PATH");
    expect(install!.run).toMatch(/gitleaks"? version/u);
    expect(steps.indexOf(restore!)).toBeLessThan(steps.indexOf(install!));
    expect(steps.indexOf(install!)).toBeLessThan(steps.findIndex((step) => /npm test/u.test(step.run ?? "")));
    // no other job downloads it
    for (const [name, job] of Object.entries(wf.jobs)) if (name !== "gitleaks" && name !== "test") expect(JSON.stringify(job), name).not.toContain("gitleaks/releases");
  });
});
