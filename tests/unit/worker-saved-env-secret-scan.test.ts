// SH22: "no secrets in any layer". The scan finds the credentials a staged tree could hold, by exact value, by file, and by shape, reports kind and path only, and never follows a link or reads outside the tree.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanTreeForSecrets, type SecretScanResult } from "../../packages/worker/src/saved-env/secret-scan.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function tree(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scan-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}
// Every secret-shaped value is built at run time, so no key-shaped string is in this file.
const rep = (char: string, n: number) => char.repeat(n);
const githubToken = () => ["gh", "p_", rep("a", 36)].join("");
const awsKeyId = () => ["AK", "IA", rep("Q", 16)].join("");
const pemHeader = () => ["-----BEGIN ", "RSA PRIV", "ATE KEY-----"].join("");
const urlWithPassword = () => ["https://", "ci:", rep("p", 12), "@git.example.com/org/repo.git"].join("");
const found = (result: SecretScanResult) => (result.ok ? [] : result.reason === "found" ? result.findings : [{ kind: result.detail, path: "" }]);

describe("secret scan", () => {
  it("a clean tree passes, and counts what it read", async () => {
    const root = await tree({ "svc/src/app.py": "print('hello')\n", "svc/package.json": '{"name":"x"}', "svc/.git/config": "[remote \"origin\"]\n\turl = https://github.com/acme/svc.git\n", "svc/.git/objects/ab/cd": Buffer.from([0, 1, 2]) });
    const result = await scanTreeForSecrets(root);
    expect(result).toMatchObject({ ok: true });
  });

  it("finds an exact value Rovara's own machinery held (the registry login, a clone credential), in any file and in dependency folders", async () => {
    const value = ["clone", "-", rep("z", 24)].join("");
    const root = await tree({ "svc/node_modules/pkg/cache.json": `{"x":"${value}"}`, "svc/notes.txt": "nothing" });
    const result = await scanTreeForSecrets(root, { forbiddenValues: [value] });
    expect(found(result)).toEqual([{ kind: "forbidden_value", path: "svc/node_modules/pkg/cache.json" }]);
  });

  it("ignores a forbidden value shorter than 8 characters (it would match by chance)", async () => {
    const root = await tree({ "a.txt": "abc abc" });
    expect((await scanTreeForSecrets(root, { forbiddenValues: ["abc"] })).ok).toBe(true);
  });

  it("finds credential files by name: .env, .git-credentials, .netrc, a private key file; but not .env.example", async () => {
    const root = await tree({ "svc/.env": "A=1", "svc/.env.local": "A=1", "svc/.git-credentials": "x", "svc/.netrc": "x", "svc/.ssh/id_ed25519": "x", "svc/.env.example": "A=", "svc/.aws/credentials": "x" });
    const kinds = found(await scanTreeForSecrets(root, { maxFindings: 50 })).map((f) => f.path).sort();
    expect(kinds).toEqual(["svc/.aws/credentials", "svc/.env", "svc/.env.local", "svc/.git-credentials", "svc/.netrc", "svc/.ssh/id_ed25519"]);
  });

  it("finds a token in a registry config file, and a login in .docker/config.json, but not an empty or settings-only one", async () => {
    const withToken = await tree({ "svc/.npmrc": `//registry.example.com/:_authToken=${rep("t", 24)}\n` });
    expect(found(await scanTreeForSecrets(withToken)).map((f) => f.kind)).toEqual(["credential_file"]);
    const clean = await tree({ "svc/.npmrc": "registry=https://registry.example.com/\nfund=false\n", "svc/.docker/config.json": '{"currentContext":"default"}' });
    expect((await scanTreeForSecrets(clean)).ok).toBe(true);
    const login = await tree({ "svc/.docker/config.json": `{"auths":{"registry.example.com":{"auth":"${rep("Q", 20)}"}}}` });
    expect(found(await scanTreeForSecrets(login)).map((f) => f.kind)).toEqual(["credential_file"]);
  });

  it("finds a private key block, a provider token, an AWS key id, a URL with a password, in the project's own files", async () => {
    const root = await tree({
      "svc/deploy.pem.txt": `${pemHeader()}\nabc\n`, "svc/ci.yml": `token: ${githubToken()}\n`, "svc/a.ini": `key=${awsKeyId()}\n`, "svc/remote.sh": `git clone ${urlWithPassword()}\n`,
      "svc/aws.cfg": `aws_secret_access_key = ${rep("s", 40)}\n`,
    });
    const byPath = Object.fromEntries(found(await scanTreeForSecrets(root, { maxFindings: 50 })).map((f) => [f.path, f.kind]));
    expect(byPath).toEqual({ "svc/deploy.pem.txt": "private_key", "svc/ci.yml": "token", "svc/a.ini": "token", "svc/remote.sh": "url_password", "svc/aws.cfg": "aws_secret" });
  });

  it("accepts documentation examples and placeholders: the AWS example key, a user name with no password, ${TOKEN} in a URL", async () => {
    const root = await tree({
      "svc/README.md": "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
      "svc/clone.sh": "git clone git@github.com:acme/repo.git\ngit clone https://ci:${TOKEN}@git.example.com/o/r.git\n",
    });
    expect((await scanTreeForSecrets(root)).ok).toBe(true);
  });

  it("dependency folders: a private key in a package's test fixture passes, a provider token does not", async () => {
    const fixture = await tree({ "svc/node_modules/ssh2/test/fixtures/key.txt": `${pemHeader()}\nabc\n` });
    expect((await scanTreeForSecrets(fixture)).ok).toBe(true);
    const token = await tree({ "svc/.venv/lib/python3.12/site-packages/x/conf.py": `T = "${githubToken()}"\n` });
    expect(found(await scanTreeForSecrets(token)).map((f) => f.kind)).toEqual(["token"]);
  });

  it(".git/config with a credential section, an extra header or a URL with a password is refused; a plain remote is not", async () => {
    for (const config of ["[credential]\n\thelper = store\n", '[http "https://x"]\n\textraheader = AUTHORIZATION: basic abc\n', `[remote "origin"]\n\turl = ${urlWithPassword()}\n`]) {
      const root = await tree({ "svc/.git/config": config });
      expect(found(await scanTreeForSecrets(root)).map((f) => f.kind).length).toBe(1);
    }
    const plain = await tree({ "svc/.git/config": '[remote "origin"]\n\turl = https://github.com/acme/svc.git\n[branch "main"]\n\tremote = origin\n' });
    expect((await scanTreeForSecrets(plain)).ok).toBe(true);
  });

  it("never follows a link: a link to a file with a secret, or to a folder outside the tree, is not read", async () => {
    const outside = await tree({ "secret.txt": githubToken() });
    const root = await tree({ "svc/ok.txt": "fine" });
    await symlink(join(outside, "secret.txt"), join(root, "svc", "link.txt"));
    await symlink(outside, join(root, "svc", "dir"));
    expect((await scanTreeForSecrets(root)).ok).toBe(true);
  });

  it("reports the kind and the path and never the matched text", async () => {
    const value = githubToken();
    const root = await tree({ "svc/a.txt": `x ${value} y` });
    const result = await scanTreeForSecrets(root);
    expect(JSON.stringify(result)).not.toContain(value);
    expect(JSON.stringify(result)).not.toContain(value.slice(0, 12));
  });

  it("a tree over the file limit, or past its deadline, is unscannable (never partly scanned and passed)", async () => {
    const root = await tree({ "a.txt": "1", "b.txt": "2", "c.txt": "3" });
    expect(await scanTreeForSecrets(root, { maxFiles: 2 })).toEqual({ ok: false, reason: "unscannable", detail: "too_many_files" });
    expect(await scanTreeForSecrets(root, { maxTotalBytes: 1 })).toEqual({ ok: false, reason: "unscannable", detail: "too_many_bytes" });
    expect(await scanTreeForSecrets(root, { deadlineAtMs: 5, now: () => 10 })).toEqual({ ok: false, reason: "unscannable", detail: "deadline" });
  });

  it("a binary file is searched for exact values but not for shapes", async () => {
    const value = ["clone", "-", rep("q", 24)].join("");
    const root = await tree({ "svc/blob.bin": Buffer.concat([Buffer.from([0, 0, 0]), Buffer.from(value), Buffer.from([0])]), "svc/other.bin": Buffer.concat([Buffer.from([0]), Buffer.from(githubToken())]) });
    const result = await scanTreeForSecrets(root, { forbiddenValues: [value], maxFindings: 5 });
    expect(found(result)).toEqual([{ kind: "forbidden_value", path: "svc/blob.bin" }]);
  });
});
