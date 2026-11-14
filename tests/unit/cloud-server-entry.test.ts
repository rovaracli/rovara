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
    env: { PATH: process.env.PATH ?? "", ROVARA_CODE_URL: "https://code.example.test", ROVARA_CLIENT_SECRET: "test-only", CLOUD_APP_DIRECTORY: appDirectory, PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  const ready = new Promise<string>((resolve) => {
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.includes("Rovara Cloud on")) resolve(output); });
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

  it("refuses a plain-http address other than its own loopback one", async () => {
    const { exited } = start({ CLOUD_ORIGIN: "http://cloud.example.test" });
    const { code, output } = await exited;
    expect(code).not.toBe(0);
    expect(output).toContain("CLOUD_ORIGIN must be an https address or http://127.0.0.1:0");
  }, 30_000);
});
