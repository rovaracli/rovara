import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { npmLauncher, tarballIntegrity } from "../../../packages/gateway/src/mcp-host.js";

const spec = { registry: "npm" as const, name: "@acme/sim-mcp", version: "1.4.2", args: ["--read-only"], destinations: [], secretEnv: [], size: { cpu: 256 as const, memoryMiB: 512 as const } };

/** An `npm` that writes what `npm pack` and `npm install` would, with the tarball bytes the "registry" serves. */
function fakeNpm(options: { tarball: Buffer; bin?: unknown }) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec = async (command: string, args: string[], run: { cwd: string }): Promise<string> => {
    calls.push({ command, args });
    if (args[0] === "pack") {
      await writeFile(join(run.cwd, "acme-sim-mcp-1.4.2.tgz"), options.tarball);
      return JSON.stringify([{ filename: "acme-sim-mcp-1.4.2.tgz" }]);
    }
    const folder = join(run.cwd, "node_modules", "@acme", "sim-mcp");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "package.json"), JSON.stringify({ name: "@acme/sim-mcp", bin: options.bin ?? { "sim-mcp": "cli.js" } }));
    return "";
  };
  return { exec, calls };
}
const folder = () => mkdtemp(join(tmpdir(), "launcher-"));

describe("review I3: the host pins the tarball", () => {
  const bytes = Buffer.from("the bytes of the tarball");
  it("hashes the downloaded file itself, and returns its integrity when the admin typed none", async () => {
    const npm = fakeNpm({ tarball: bytes });
    const prepared = await npmLauncher({ exec: npm.exec }).prepare(spec, await folder());
    expect(prepared.integrity).toBe(tarballIntegrity(bytes));
    expect(prepared.args).toEqual(["--read-only"]);
    expect(prepared.command.endsWith(join("node_modules", ".bin", "sim-mcp"))).toBe(true);
  });
  it("installs from that file with scripts off, never with npx, and never twice", async () => {
    const npm = fakeNpm({ tarball: bytes });
    await npmLauncher({ exec: npm.exec }).prepare({ ...spec, integrity: tarballIntegrity(bytes) }, await folder());
    expect(npm.calls.map((call) => call.command)).toEqual(["npm", "npm"]);
    const install = npm.calls[1]!;
    expect(install.args).toEqual(expect.arrayContaining(["install", "--ignore-scripts", "--no-audit"]));
    expect(install.args.at(-1)).toMatch(/acme-sim-mcp-1\.4\.2\.tgz$/u);
    expect(npm.calls[0]!.args).toEqual(expect.arrayContaining(["pack", "@acme/sim-mcp@1.4.2", "--ignore-scripts"]));
  });
  it("refuses, before anything is installed, a tarball whose bytes are not the pinned ones (a registry that serves other bytes for the same version)", async () => {
    const npm = fakeNpm({ tarball: Buffer.from("different bytes") });
    await expect(npmLauncher({ exec: npm.exec }).prepare({ ...spec, integrity: tarballIntegrity(bytes) }, await folder())).rejects.toThrow("integrity mismatch");
    expect(npm.calls.map((call) => call.args[0])).toEqual(["pack"]);
  });
  it("refuses a package with no program, a program name with a path in it, and a tarball name with one", async () => {
    await expect(npmLauncher({ exec: fakeNpm({ tarball: bytes, bin: {} }).exec }).prepare(spec, await folder())).rejects.toThrow("no program");
    await expect(npmLauncher({ exec: fakeNpm({ tarball: bytes, bin: { "../evil": "x.js" } }).exec }).prepare(spec, await folder())).rejects.toThrow("no program");
    const evil = async (command: string, args: string[]) => (args[0] === "pack" ? JSON.stringify([{ filename: "../../etc/x.tgz" }]) : command);
    await expect(npmLauncher({ exec: evil }).prepare(spec, await folder())).rejects.toThrow("no tarball");
  });
  it("takes a string bin as the package's own name", async () => {
    const prepared = await npmLauncher({ exec: fakeNpm({ tarball: bytes, bin: "cli.js" }).exec }).prepare(spec, await folder());
    expect(prepared.command.endsWith("sim-mcp")).toBe(true);
  });
});
