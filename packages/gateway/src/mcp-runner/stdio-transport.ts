// Stdio MCP host redesign (T4): a stdio client transport for the program the bridge starts. It differs from the MCP SDK's own in three ways that matter here: the child's stderr
// is read and COUNTED but never kept (a server's own text can hold secrets, paths and banners), the read buffer is bounded, and the child is stopped by its process group.
//
// It carries no uid. The lane E host moved each server to another uid with `spawn({ uid })`; there is no root and no uid pool now, so the confinement is the task itself plus the
// wrapper the bridge puts in front of the program (confine.ts).
import { spawn } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** The most the child may write in one message, and so the most that is buffered. */
export const STDIO_BUFFER_MAX_BYTES = 1_048_576;

export interface ChildProcessSpec { file: string; args: string[]; env: Record<string, string>; cwd: string }

export class StdioChildTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child: ReturnType<typeof spawn> | undefined;
  private readonly buffer = new ReadBuffer({ maxBufferSize: STDIO_BUFFER_MAX_BYTES });
  private stderrCount = 0;
  /** `afterSpawn` runs as soon as the program has been started: the environment it was given is cleared from this object then, so no secret is held here afterwards. */
  constructor(private readonly spec: ChildProcessSpec, private readonly spawnProcess: typeof spawn = spawn, private readonly afterSpawn?: () => void) {}

  /** How many bytes the child has written to stderr. The bytes themselves are discarded. */
  stderrBytes(): number { return this.stderrCount; }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = this.spawnProcess(this.spec.file, this.spec.args, {
        env: this.spec.env, cwd: this.spec.cwd, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, detached: true,
      });
      this.child = child;
      for (const key of Object.keys(this.spec.env)) delete this.spec.env[key];
      this.afterSpawn?.();
      child.on("error", (error) => { reject(error); this.onerror?.(error); });
      // A program that stops reading leaves a write to fail (EPIPE). That is an error to report, not an unhandled one that would stop the bridge before it can say why. This is the
      // only error listener on stdin: it is added once here and never per write.
      child.stdin?.on("error", (error) => { this.onerror?.(error); });
      child.on("spawn", () => resolve());
      child.on("close", () => { this.child = undefined; this.onclose?.(); });
      child.stderr?.on("data", (chunk: Buffer) => { this.stderrCount += chunk.length; });
      child.stdout?.on("data", (chunk: Buffer) => {
        try {
          this.buffer.append(chunk);
          for (let message = this.buffer.readMessage(); message !== null; message = this.buffer.readMessage()) this.onmessage?.(message);
        } catch (error) { this.onerror?.(error instanceof Error ? error : new Error("bad output")); void this.close(); }
      });
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (stdin === null || stdin === undefined) throw new Error("not connected");
    // The write's own callback says when it was flushed or failed, so a send adds no listener to the stream (the one error listener is added once, when the program starts).
    await new Promise<void>((resolve, reject) => { stdin.write(serializeMessage(message), (error) => { if (error) reject(error); else resolve(); }); });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.buffer.clear();
    if (child === undefined) return;
    child.stdin?.end();
    const killGroup = (signal: NodeJS.Signals): void => {
      try { if (child.pid !== undefined) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already gone */ }
    };
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { killGroup("SIGKILL"); resolve(); }, 2_000);
      child.once("close", () => { clearTimeout(timer); killGroup("SIGKILL"); resolve(); });
      killGroup("SIGTERM");
    });
  }
}
