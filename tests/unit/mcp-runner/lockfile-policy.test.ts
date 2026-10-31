// Stdio MCP host redesign, task T2: the dependency rules, checked on fixture lockfiles. Each refused form has a case, and each case has a positive control (the same
// lockfile with only that form fixed is accepted), so a rule cannot pass by refusing everything.
import { describe, expect, it } from "vitest";
import { LOCKFILE_LIMITS, checkLockfile, lockfileHash } from "../../../packages/gateway/src/mcp-runner/lockfile-policy.js";

const REGISTRY = "https://registry.corp.example/npm/";
const SHA512 = (seed: string) => `sha512-${seed.repeat(86).slice(0, 86)}==`;
const url = (name: string, version = "1.0.0") => `${REGISTRY}${name}/-/${name.split("/").at(-1)}-${version}.tgz`;

type Pkg = Record<string, unknown>;
const pkg = (name: string, over: Pkg = {}): Pkg => ({ version: "1.0.0", resolved: url(name), integrity: SHA512("A"), ...over });
function lock(packages: Record<string, Pkg>, over: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: "root", version: "1.4.2", lockfileVersion: 3, requires: true, packages: { "": { name: "root", version: "1.4.2" }, ...packages }, ...over });
}
const good = { "node_modules/left-pad": pkg("left-pad"), "node_modules/@scope/util": pkg("@scope/util"), "node_modules/left-pad/node_modules/inner": pkg("inner") };
const check = (text: string, over: Partial<Parameters<typeof checkLockfile>[1]> = {}) => checkLockfile(text, { registry: REGISTRY, ...over });
const refused = (text: string, rule: string) => {
  const verdict = check(text);
  expect(verdict.ok).toBe(false);
  if (!verdict.ok) { expect(verdict.rule).toBe(rule); expect(verdict.sentence.length).toBeGreaterThan(10); }
  return verdict;
};

describe("T2 lockfile policy: a clean lockfile", () => {
  it("is accepted", () => {
    expect(check(lock(good))).toEqual({ ok: true, packageCount: 3 });
  });
  it("hashes the exact bytes (sha256 hex)", () => {
    expect(lockfileHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(lockfileHash(Buffer.from("abc"))).toBe(lockfileHash("abc"));
    expect(lockfileHash(lock(good))).not.toBe(lockfileHash(`${lock(good)} `));
  });
  it("does not count development-only packages, which `npm ci --omit=dev` never installs, and does not refuse their install steps", () => {
    const withDev = { ...good, "node_modules/devtool": pkg("devtool", { dev: true, hasInstallScript: true }) };
    expect(check(lock(withDev))).toMatchObject({ ok: true, packageCount: 3 });
  });
  it("still holds development-only packages to the registry and integrity rules: a `dev` flag in the file is not trusted to say nothing is fetched", () => {
    refused(lock({ ...good, "node_modules/devtool": pkg("devtool", { dev: true, resolved: "git+ssh://git@github.com/x/y.git#abc" }) }), "registry_only");
    refused(lock({ ...good, "node_modules/devtool": pkg("devtool", { dev: true, resolved: "https://registry.npmjs.org/devtool/-/devtool-1.0.0.tgz" }) }), "registry_only");
    refused(lock({ ...good, "node_modules/devtool": pkg("devtool", { dev: true, integrity: "sha1-xx" }) }), "integrity");
  });
  it("accepts optional platform packages (the common prebuilt pattern)", () => {
    expect(check(lock({ ...good, "node_modules/@esbuild/darwin-arm64": pkg("@esbuild/darwin-arm64", { optional: true }) }))).toMatchObject({ ok: true, packageCount: 4 });
  });
  it("accepts a registry with a path prefix only for addresses under that prefix", () => {
    expect(check(lock(good), { registry: "https://registry.corp.example/npm" })).toMatchObject({ ok: true });
    expect(check(lock({ "node_modules/a": pkg("a", { resolved: "https://registry.corp.example/other/a/-/a-1.0.0.tgz" }) }))).toMatchObject({ ok: false, rule: "registry_only" });
    expect(check(lock({ "node_modules/a": pkg("a", { resolved: "https://registry.corp.example/a/-/a-1.0.0.tgz" }) }), { registry: "https://registry.corp.example/" })).toMatchObject({ ok: true });
  });
});

describe("T2 lockfile policy rule 1: registry only", () => {
  const forms: Array<[string, string]> = [
    ["git+ssh", "git+ssh://git@github.com/acme/dep.git#0123456789abcdef"],
    ["git+https", "git+https://github.com/acme/dep.git#0123456789abcdef"],
    ["git://", "git://github.com/acme/dep.git"],
    ["github:", "github:acme/dep#main"],
    ["file:", "file:../dep"],
    ["link:", "link:../dep"],
    ["a plain relative path", "../dep"],
    ["http (not https)", "http://registry.corp.example/npm/dep/-/dep-1.0.0.tgz"],
    ["another host", "https://registry.npmjs.org/dep/-/dep-1.0.0.tgz"],
    ["a look-alike host", "https://registry.corp.example.evil.test/npm/dep/-/dep-1.0.0.tgz"],
    ["a login that hides the real host", "https://registry.corp.example@evil.test/npm/dep/-/dep-1.0.0.tgz"],
    ["credentials on the registry host", "https://user:pw@registry.corp.example/npm/dep/-/dep-1.0.0.tgz"],
    ["a different port", "https://registry.corp.example:8443/npm/dep/-/dep-1.0.0.tgz"],
    ["a tarball URL on another host", "https://example.com/dep.tgz"],
    ["a string that is not an address", "not a url"],
  ];
  for (const [label, resolved] of forms) {
    it(`refuses ${label}, naming the rule and the package`, () => {
      const verdict = refused(lock({ "node_modules/dep": pkg("dep", { resolved }) }), "registry_only");
      if (!verdict.ok) { expect(verdict.package).toBe("dep"); expect(verdict.sentence).toMatch(/registry/); }
    });
  }
  it("says it is a git dependency when it is one", () => {
    const verdict = refused(lock({ "node_modules/dep": pkg("dep", { resolved: "github:acme/dep" }) }), "registry_only");
    expect(!verdict.ok && verdict.sentence).toBe("This package needs a git dependency. Rovara installs only from your registry.");
  });
  it("refuses a package with no resolved address", () => {
    refused(lock({ "node_modules/dep": pkg("dep", { resolved: undefined }) }), "registry_only");
    refused(lock({ "node_modules/dep": pkg("dep", { resolved: 7 }) }), "registry_only");
  });
  it("refuses a link entry (a workspace or file: dependency), whatever else it says", () => {
    refused(lock({ "node_modules/dep": { resolved: "packages/dep", link: true } }), "registry_only");
    refused(lock({ "node_modules/dep": pkg("dep", { link: true }) }), "registry_only");
  });
  it("refuses an alias (`npm:`) that resolves elsewhere, and accepts one that resolves on the registry", () => {
    refused(lock({ "node_modules/alias": pkg("real", { name: "real", resolved: "https://registry.npmjs.org/real/-/real-1.0.0.tgz" }) }), "registry_only");
    expect(check(lock({ "node_modules/alias": pkg("real", { name: "real" }) }))).toMatchObject({ ok: true });
  });
  it("refuses a package path that is not inside node_modules (a workspace, an escape, an absolute path)", () => {
    for (const path of ["packages/dep", "../dep", "/etc/dep", "node_modules/../x", "node_modules/a/../b", "node_modules/", "node_modules//a"]) {
      refused(lock({ [path]: pkg("dep") }), "registry_only");
    }
  });
  it("a name taken from the lockfile is shown only if it is a plain npm name", () => {
    const verdict = refused(lock({ "node_modules/<script>alert(1)</script>": pkg("x", { resolved: "github:a/b" }) }), "registry_only");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) { expect(verdict.package).toBeUndefined(); expect(verdict.sentence).not.toContain("<script>"); }
  });
  it("refuses an unusable registry setting instead of checking against it", () => {
    for (const registry of ["http://registry.corp.example/", "not a url", "https://user:pw@registry.corp.example/", ""]) expect(() => checkLockfile(lock(good), { registry }), registry).toThrow();
  });
});

describe("T2 lockfile policy rule 2: integrity everywhere", () => {
  const forms: Array<[string, unknown]> = [
    ["missing", undefined],
    ["sha1", "sha1-qUHpFw1Pv//Lkz2Qx6hW8mQe0bU="],
    ["sha256", `sha256-${"A".repeat(43)}=`],
    ["sha384", `sha384-${"A".repeat(64)}`],
    ["sha1 and sha512 together", `sha1-qUHpFw1Pv//Lkz2Qx6hW8mQe0bU= ${SHA512("A")}`],
    ["two sha512 together", `${SHA512("A")} ${SHA512("B")}`],
    ["a sha512 with trailing text", `${SHA512("A")} extra`],
    ["a sha512 that is too short", "sha512-AAAA"],
    ["not a string", 12],
    ["empty", ""],
  ];
  for (const [label, integrity] of forms) {
    it(`refuses ${label}`, () => {
      const verdict = refused(lock({ "node_modules/dep": pkg("dep", { integrity }) }), "integrity");
      if (!verdict.ok) expect(verdict.package).toBe("dep");
    });
  }
  it("accepts a sha512 (positive control for the cases above)", () => {
    expect(check(lock({ "node_modules/dep": pkg("dep", { integrity: SHA512("Z") }) }))).toMatchObject({ ok: true });
  });
});

describe("T2 lockfile policy: packages bundled inside another package's tarball", () => {
  const holder = { "node_modules/holder": pkg("holder") };
  it("accepts a bundled package with no address and no checksum when the package that holds it has both", () => {
    expect(check(lock({ ...holder, "node_modules/holder/node_modules/inside": { version: "1.0.0", inBundle: true } }))).toMatchObject({ ok: true, packageCount: 2 });
    expect(check(lock({ ...holder, "node_modules/holder/node_modules/mid": { version: "1.0.0", inBundle: true }, "node_modules/holder/node_modules/mid/node_modules/deep": { version: "1.0.0", inBundle: true } }))).toMatchObject({ ok: true });
  });
  it("refuses an inBundle entry with no holder, a holder without a checksum, or a holder that is a link", () => {
    refused(lock({ "node_modules/orphan": { version: "1.0.0", inBundle: true } }), "registry_only");
    refused(lock({ "node_modules/holder": pkg("holder", { integrity: undefined }), "node_modules/holder/node_modules/inside": { version: "1.0.0", inBundle: true } }), "integrity");
    refused(lock({ "node_modules/holder": { link: true, resolved: "x" }, "node_modules/holder/node_modules/inside": { version: "1.0.0", inBundle: true } }), "registry_only");
  });
  it("does not let `inBundle` excuse an address that is off the registry", () => {
    refused(lock({ ...holder, "node_modules/holder/node_modules/inside": { version: "1.0.0", inBundle: true, resolved: "github:a/b" } }), "registry_only");
    refused(lock({ ...holder, "node_modules/holder/node_modules/inside": { version: "1.0.0", inBundle: true, resolved: url("inside"), integrity: "sha1-xx" } }), "integrity");
  });
  it("does not accept a missing address and checksum without the inBundle flag", () => {
    refused(lock({ ...holder, "node_modules/holder/node_modules/inside": { version: "1.0.0" } }), "registry_only");
  });
});

describe("T2 lockfile policy rule 3: install steps and native builds are refused (owner decision, v1)", () => {
  it("refuses a package whose entry says it has install steps, naming the rule and the package", () => {
    const verdict = refused(lock({ ...good, "node_modules/native": pkg("native", { hasInstallScript: true }) }), "install_scripts");
    if (!verdict.ok) {
      expect(verdict.package).toBe("native");
      expect(verdict.sentence).toBe("The dependency native needs install steps or a native build. Rovara does not run install steps, so this package cannot be used yet.");
    }
  });
  it("refuses it at any depth, scoped or not, optional or not, and without a name it can show", () => {
    refused(lock({ ...good, "node_modules/a/node_modules/b": pkg("b", { hasInstallScript: true }), "node_modules/a": pkg("a") }), "install_scripts");
    refused(lock({ "node_modules/@scope/native": pkg("@scope/native", { hasInstallScript: true }) }), "install_scripts");
    refused(lock({ "node_modules/@esbuild/darwin-arm64": pkg("@esbuild/darwin-arm64", { optional: true, hasInstallScript: true }) }), "install_scripts");
    const verdict = refused(lock({ "node_modules/<b>": pkg("x", { hasInstallScript: true }) }), "install_scripts");
    expect(!verdict.ok && verdict.package).toBeUndefined();
  });
  it("refuses any value but an explicit false (a flag the file writes in another form is not read as 'no')", () => {
    for (const value of [true, "true", 1, "yes", {}, []]) refused(lock({ "node_modules/x": pkg("x", { hasInstallScript: value }) }), "install_scripts");
    for (const value of [false, undefined]) expect(check(lock({ "node_modules/x": pkg("x", { hasInstallScript: value }) }))).toMatchObject({ ok: true });
  });
});

describe("T2 lockfile policy rule 4: bounds and format", () => {
  const many = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`node_modules/p${index}`, pkg(`p${index}`)]));
  it("allows 1,500 packages and refuses 1,501", () => {
    expect(LOCKFILE_LIMITS.maxPackages).toBe(1_500);
    expect(check(lock(many(1_500)))).toMatchObject({ ok: true, packageCount: 1_500 });
    refused(lock(many(1_501)), "bounds");
  });
  it("takes the limits as settings", () => {
    expect(check(lock(many(5)), { maxPackages: 5 })).toMatchObject({ ok: true });
    expect(check(lock(many(6)), { maxPackages: 5 })).toMatchObject({ ok: false, rule: "bounds" });
    expect(check(lock(many(5)), { maxLockfileBytes: 100 })).toMatchObject({ ok: false, rule: "bounds" });
  });
  it("refuses a lockfile that is too big before parsing it", () => {
    expect(check("x".repeat(LOCKFILE_LIMITS.maxLockfileBytes + 1))).toMatchObject({ ok: false, rule: "bounds" });
  });
  it("refuses what it cannot read: not JSON, not an object, version 1, no packages map, a package that is not an object", () => {
    for (const text of ["", "{", "[]", "null", "7", lock(good, { lockfileVersion: 1 }), lock(good, { lockfileVersion: 4 }), lock(good, { lockfileVersion: "3" }), JSON.stringify({ lockfileVersion: 3 }), JSON.stringify({ lockfileVersion: 3, packages: [] }), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/a": 5 } }), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/a": null } })]) {
      refused(text, "lockfile_format");
    }
  });
  it("reads bytes as well as text", () => {
    expect(check(lock(good))).toEqual(checkLockfile(Buffer.from(lock(good)), { registry: REGISTRY }));
  });
  it("gives the same verdict whatever order the packages are written in", () => {
    const reversed = Object.fromEntries(Object.entries(good).reverse());
    expect(check(lock(reversed))).toEqual(check(lock(good)));
    const bad = { "node_modules/z": pkg("z", { resolved: "github:a/b" }), "node_modules/a": pkg("a", { integrity: "sha1-x" }) };
    expect(check(lock(bad))).toEqual(check(lock(Object.fromEntries(Object.entries(bad).reverse()))));
  });
});
