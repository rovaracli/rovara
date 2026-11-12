// The model stand-in image (lane SM3, environments/model-stand-in) and its catalog entry (`model-stand-in@r1`): built from a clean checkout, bases pinned by digest, not root, standard library only, port 8080, and the entry's run
// contract is what the Containerfile and the launcher (service-helpers.ts) assume. The Go unit, fuzz and live tests run in the image build and in the Linux VM (the lane report); this keeps the definition honest.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CatalogEntrySchema, ServiceCatalogSchema } from "@rovara-code/contracts";
import { modelStandInEntry } from "../support/model-stand-in-entry.js";
import { MODEL_STAND_IN_CONFIG_TARGET } from "../../packages/worker/src/service-helpers.js";

const root = new URL("../../", import.meta.url).pathname;
const context = "environments/model-stand-in";
const containerfile = readFileSync(join(root, context, "Containerfile"), "utf8");
const tracked = new Set(execFileSync("git", ["ls-files", "-z", "--", context], { cwd: root, encoding: "utf8" }).split("\0").filter((name) => name !== ""));
const catalog = ServiceCatalogSchema.parse(JSON.parse(readFileSync(join(root, "environments/service-catalog/catalog.json"), "utf8")));
const entry = modelStandInEntry();
const goSource = (name: string): string => readFileSync(join(root, context, name), "utf8");

describe("the model stand-in image definition", () => {
  it("pins every base image by digest, the Go build image to the reviewed digest", () => {
    const froms = containerfile.split("\n").filter((line) => /^FROM\s/.test(line));
    expect(froms.length).toBe(2);
    for (const line of froms) expect(line, line).toMatch(/^FROM [A-Za-z0-9._/:-]+@sha256:[0-9a-f]{64}( AS \w+)?$/);
    expect(froms[0]).toBe("FROM public.ecr.aws/docker/library/golang:1.26.11-bookworm@sha256:dc40a13b61304647ed7e5d581d246b86413dfc29d63c6d018310feb93cd98fc0 AS build");
    expect(froms[1]).toMatch(/^FROM gcr\.io\/distroless\/static-debian12:nonroot@sha256:/);
  });

  it("runs as the catalog's numeric non-root user with a fixed entrypoint, exposes 8080 and reads the config the launcher mounts", () => {
    const user = /^USER ([1-9][0-9]*:[1-9][0-9]*)$/m.exec(containerfile);
    expect(user, "a numeric non-root USER").not.toBeNull();
    expect(user![1]).toBe(entry.run.user);
    expect(containerfile).toMatch(/^ENTRYPOINT \["\/usr\/local\/bin\/model-stand-in"\]$/m);
    expect(containerfile).not.toMatch(/^\s*ADD\s/m);
    expect(containerfile).toMatch(/^EXPOSE 8080$/m);
    expect(containerfile).toContain(`CMD ["--config", "${MODEL_STAND_IN_CONFIG_TARGET}"]`);
    expect(goSource("cmd/model-stand-in/main.go")).toContain(`"${MODEL_STAND_IN_CONFIG_TARGET}"`);
  });

  it("copies only tracked files, and uses no module outside the standard library", () => {
    for (const source of ["go.mod", "cmd", "internal"]) {
      expect(existsSync(join(root, context, source)), source).toBe(true);
      expect([...tracked].some((name) => name === `${context}/${source}` || name.startsWith(`${context}/${source}/`)), `${source} tracked`).toBe(true);
    }
    const gomod = goSource("go.mod");
    expect(gomod).not.toMatch(/^\s*require\b/m);
    expect(existsSync(join(root, context, "go.sum"))).toBe(false);
    for (const name of tracked) {
      if (!name.endsWith(".go")) continue;
      for (const match of readFileSync(join(root, name), "utf8").matchAll(/^\s+(?:\w+\s+)?"([^"]+)"$/gm)) {
        if (!/^[a-z]/.test(match[1]!)) continue;
        expect(match[1]!.split("/")[0]!, `${name} imports ${match[1]!}`).not.toContain(".");
      }
    }
  });

  it("holds the Go floor: go.mod and the build image are 1.26.9 or newer (GO-2026-6612 is fixed there), with no toolchain download", () => {
    const FLOOR = [1, 26, 9];
    const atLeast = (version: string): boolean => {
      const parts = version.split(".").map(Number);
      for (let i = 0; i < 3; i += 1) {
        const have = parts[i] ?? 0;
        if (have !== FLOOR[i]) return have > FLOOR[i]!;
      }
      return true;
    };
    const directive = /^go (\d+\.\d+(?:\.\d+)?)$/m.exec(goSource("go.mod"));
    expect(directive, "go.mod has a go directive").not.toBeNull();
    expect(atLeast(directive![1]!), `go.mod says go ${directive![1]}`).toBe(true);
    const base = /^FROM \S*\/golang:(\d+\.\d+\.\d+)-bookworm@sha256:[0-9a-f]{64} AS build$/m.exec(containerfile);
    expect(base, "the build stage is golang:<x.y.z>-bookworm by digest").not.toBeNull();
    expect(atLeast(base![1]!), `build image is golang ${base![1]}`).toBe(true);
    expect(containerfile).toMatch(/GOTOOLCHAIN=local/);
    // the floor check itself rejects an older version
    expect(atLeast("1.26.8")).toBe(false);
    expect(atLeast("1.25.9")).toBe(false);
    expect(atLeast("1.26.9")).toBe(true);
    expect(atLeast("1.27.0")).toBe(true);
  });

  it("runs the vet and the unit tests in the image build, so an image that does not pass them is never produced", () => {
    expect(containerfile).toMatch(/RUN go vet \.\/\.\.\. && go test -count=1 \.\/\.\.\./);
  });

  it("has no dialling code: no HTTP client, no dial, no lookup, no process, no TLS, no plugin (the sealed run has no route out either; the Go test holds the same)", () => {
    for (const name of tracked) {
      if (!name.endsWith(".go") || name.endsWith("_test.go")) continue;
      const code = readFileSync(join(root, name), "utf8").split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
      expect(code, name).not.toMatch(/\bhttp\.(Get|Post|PostForm|Head|DefaultClient|Client|Transport|NewRequest)\b|\bnet\.(Dial\w*|Lookup\w*|DefaultResolver|Dialer)\b|"os\/exec"|"unsafe"|"plugin"|"crypto\/tls"/);
    }
  });

  it("keeps secrets out of the source: no key-shaped literal", () => {
    for (const name of tracked) {
      const text = readFileSync(join(root, name), "utf8");
      expect(text, name).not.toMatch(/AKIA[0-9A-Z]{16}/);
      expect(text, name).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    }
  });
});

describe("the catalog entry model-stand-in@r1", () => {
  it("is a Rovara-built helper for both platforms, offered in both editions, never the default, and parses on its own", () => {
    expect(entry).toBeDefined();
    expect(CatalogEntrySchema.parse(entry)).toEqual(entry);
    expect(entry).toMatchObject({ family: "model-stand-in", version: "r1", status: "available", image: { repository: "svc/model-stand-in", platforms: ["linux/arm64", "linux/amd64"] }, editions: ["public", "enterprise"] });
    expect(entry.workerImage).toBeUndefined();
  });
  it("runs without root on a read-only root with the memory, CPU and pid limits of a small server, no tmpfs and no fixed argument", () => {
    expect(entry.run).toEqual({ user: "65532:65532", readOnlyRoot: true, tmpfs: [], ports: [8080, 8081, 8082, 8083], extraArgs: [] });
    expect(entry.resources).toEqual({ memMiB: 128, cpus: 0.5, pids: 64 });
    expect(entry.reset).toEqual({ kind: "restart" });
  });
  it("is healthy when GET /ping answers on 8080 (SageMaker's container contract), within 15 seconds", () => {
    expect(entry.health).toEqual({ kind: "http", port: 8080, path: "/ping", startTimeoutS: 15 });
  });
  it("lists the primary port and at most three per-endpoint ports, as many listeners as the stand-in allows, and is reached as `model-stand-in`", () => {
    expect(goSource("internal/standin/config.go")).toMatch(/MaxListeners\s+= 4 /);
    expect(entry.run.ports.length).toBe(4);
    expect(entry.connect).toEqual({ templates: {}, defaultAliases: ["model-stand-in"] });
  });
  it("is not in the first-use lists of the other families (no dependency of a repository asks for it: only the plan's SageMaker backing does)", () => {
    for (const other of catalog.entries.filter((candidate) => candidate.id !== entry.id)) expect(other.family).not.toBe("model-stand-in");
  });
  it("the config the worker writes can be as large as the launcher's file limit (1 MiB) and the stand-in reads exactly that much", () => {
    expect(goSource("internal/standin/config.go")).toMatch(/MaxConfigBytes\s+= 1 << 20/);
    expect(readFileSync(join(root, "packages/worker/src/service-helpers.ts"), "utf8")).toMatch(/const MAX_FILE_BYTES = 1_048_576;/);
  });
});
