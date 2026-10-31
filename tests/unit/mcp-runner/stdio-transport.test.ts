// Stdio MCP host redesign, fix round 1 (m5): a write to a program that has stopped reading must not crash the bridge.
import { afterEach, describe, expect, it } from "vitest";
import { StdioChildTransport } from "../../../packages/gateway/src/mcp-runner/stdio-transport.js";

const transports: StdioChildTransport[] = [];
afterEach(async () => { for (const transport of transports.splice(0)) await transport.close(); });
const make = (script: string): StdioChildTransport => {
  const transport = new StdioChildTransport({ file: process.execPath, args: ["-e", script], env: {}, cwd: process.cwd() });
  transports.push(transport);
  return transport;
};
const message = { jsonrpc: "2.0" as const, id: 1, method: "ping" };

describe("StdioChildTransport", () => {
  it("rejects a send after the program has gone, and calls onclose", async () => {
    const transport = make("process.exit(0)");
    const closed = new Promise<void>((resolve) => { transport.onclose = resolve; });
    await transport.start();
    await closed;
    await expect(transport.send(message)).rejects.toThrow("not connected");
  });
  it("survives a program that closes its stdin and stays alive: the failed write is an error to the caller and to onerror, not an unhandled error", async () => {
    const unhandled: unknown[] = [];
    const record = (error: unknown): void => { unhandled.push(error); };
    process.on("uncaughtException", record);
    try {
      const transport = make("require('fs').closeSync(0); setTimeout(() => {}, 4000);");
      const errors: Error[] = [];
      transport.onerror = (error) => errors.push(error);
      await transport.start();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const results = await Promise.allSettled(Array.from({ length: 20 }, () => transport.send({ ...message, params: { pad: "x".repeat(70_000) } })));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(unhandled).toEqual([]);
      expect(results.some((result) => result.status === "rejected") || errors.length > 0).toBe(true);
    } finally {
      process.off("uncaughtException", record);
    }
  });
  it("adds one error listener to stdin when it starts and none per write", async () => {
    const transport = make("process.stdin.resume(); setTimeout(() => {}, 3000);");
    await transport.start();
    const stdin = (transport as unknown as { child: { stdin: { listenerCount(event: string): number } } }).child.stdin;
    const before = stdin.listenerCount("error");
    await Promise.all(Array.from({ length: 40 }, () => transport.send({ ...message, params: { pad: "x".repeat(50_000) } })));
    expect(stdin.listenerCount("error")).toBe(before);
    expect(before).toBe(1);
  });
  it("reports an error on stdin that no write is waiting for through onerror, and does not crash", async () => {
    const unhandled: unknown[] = [];
    const record = (error: unknown): void => { unhandled.push(error); };
    process.on("uncaughtException", record);
    try {
      const transport = make("require('fs').closeSync(0); setTimeout(() => {}, 3000);");
      const errors: Error[] = [];
      transport.onerror = (error) => errors.push(error);
      await transport.start();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const stdin = (transport as unknown as { child: { stdin: { emit(event: string, error: Error): boolean } } }).child.stdin;
      stdin.emit("error", new Error("EPIPE"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
      expect(errors.map((error) => error.message)).toContain("EPIPE");
    } finally { process.off("uncaughtException", record); }
  });
  it("counts the program's stderr bytes and keeps none of it", async () => {
    const transport = make("process.stderr.write('e'.repeat(5000)); setTimeout(() => {}, 300);");
    await transport.start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(transport.stderrBytes()).toBe(5000);
  });
});
