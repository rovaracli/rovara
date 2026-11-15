import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// scripts/cloud-server.ts runs Rovara Cloud on this computer (npm run cloud:local) and in its container (infra/lib/cloud-app.ts).
const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill(); });

function start(env: Record<string, string>): { child: ChildProcess; ready: Promise<string>; exited: Promise<{ code: number | null; output: string }> } {
  const appDirectory = mkdtempSync(join(tmpdir(), "cloud-app-"));
  writeFileSync(join(appDirectory, "index.html"), "<!doctype html><title>Rovara</title>");
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/cloud-server.ts"], {
    env: Object.fromEntries(Object.entries({ PATH: process.env.PATH ?? "", ROVARA_CODE_URL: "https://code.example.test", ROVARA_CLIENT_SECRET: "test-only", CLOUD_APP_DIRECTORY: appDirectory, PORT: "0", ...env })
      .filter(([name]) => name !== "unset" && name !== env.unset)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  const ready = new Promise<string>((resolve) => {
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (/Rovara Cloud (on|has moved)/u.test(output)) resolve(output); });
  });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<{ code: number | null; output: string }>((resolve) => child.on("exit", (code) => resolve({ code, output })));
  return { child, ready, exited };
}

describe("the Rovara Cloud server entry", () => {
  it("sends Code the registered https callback of its public address, and listens where it is told", async () => {
    const port = String(20000 + Math.floor(Math.random() * 20000));
    const { ready } = start({ CLOUD_ORIGIN: "https://cloud.example.test", HOST: "127.0.0.1", PORT: port });
    expect(await ready).toContain(`Rovara Cloud on https://cloud.example.test/app (listening on 127.0.0.1:${port})`);
    const answer = await fetch(`http://127.0.0.1:${port}/v1/auth/browser/authorize?return=/app`, { redirect: "manual" });
    expect(answer.status).toBe(302);
    const location = new URL(answer.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://code.example.test/v1/auth/authorize");
    expect(location.searchParams.get("client_id")).toBe("rovara-cloud");
    expect(location.searchParams.get("redirect_uri")).toBe("https://cloud.example.test/callback");
    const page = await fetch(`http://127.0.0.1:${port}/app`);
    expect(page.status).toBe(200);
    // On https the app keeps its HSTS header.
    expect(page.headers.get("strict-transport-security")).not.toBeNull();
  }, 30_000);

  it("refuses the file store and a secret in its environment when deployed", async () => {
    const fileStore = await start({ CLOUD_ENVIRONMENT: "production", ROVARA_CLIENT_SECRET: "", CLOUD_ORIGIN: "https://cloud.example.test" }).exited;
    expect(fileStore.code).not.toBe(0);
    expect(fileStore.output).toContain("A deployed Cloud reads its client secret from Secrets Manager");
    const noTable = await start({ CLOUD_ENVIRONMENT: "production", ROVARA_CLIENT_SECRET: "", CLOUD_ORIGIN: "https://cloud.example.test", AWS_REGION: "us-east-1", ROVARA_CLIENT_SECRET_ID: "x", unset: "ROVARA_CLIENT_SECRET" }).exited;
    expect(noTable.code).not.toBe(0);
    expect(noTable.output).toContain("CLOUD_SESSIONS_TABLE is required");
    expect(noTable.output).not.toContain("test-only");
  }, 30_000);

  it("refuses a plain-http address other than its own loopback one", async () => {
    const { exited } = start({ CLOUD_ORIGIN: "http://cloud.example.test" });
    const { code, output } = await exited;
    expect(code).not.toBe(0);
    expect(output).toContain("CLOUD_ORIGIN must be an https address or http://127.0.0.1:0");
  }, 30_000);
});

describe("the Rovara Cloud server entry once Cloud has moved (#11)", () => {
  it("answers every request, any method, with a 308 to the same path and query at the new address", async () => {
    const port = String(40000 + Math.floor(Math.random() * 10000));
    const { ready } = start({ CLOUD_ORIGIN: "https://old.example.test", HOST: "127.0.0.1", PORT: port, CLOUD_MOVED_TO: "https://new.example.test/" });
    expect(await ready).toContain("Rovara Cloud has moved: https://old.example.test answers every request with a redirect to https://new.example.test");
    for (const [method, path] of [["GET", "/app/projects/demo?tab=work"], ["POST", "/v1/web/sessions/ses_aaaaaaaaaaaaaaaaaaaa/messages"], ["GET", "/"], ["GET", "/callback?code=x&state=y"]] as const) {
      const answer = await fetch(`http://127.0.0.1:${port}${path}`, { method, redirect: "manual", ...(method === "POST" ? { body: "{}" } : {}) });
      expect(answer.status).toBe(308);
      expect(answer.headers.get("location")).toBe(`https://new.example.test${path}`);
    }
  }, 30_000);

  it("refuses a new address that isn't https, or has a path", async () => {
    for (const movedTo of ["http://new.example.test", "https://new.example.test/app"]) {
      const { exited } = start({ CLOUD_MOVED_TO: movedTo });
      const { code, output } = await exited;
      expect(code).not.toBe(0);
      expect(output).toContain("CLOUD_MOVED_TO must be an https address with no path");
    }
  }, 30_000);
});
