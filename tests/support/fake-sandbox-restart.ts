// A fake Docker's answers for the working sandbox's restart (TE-B1-fresh): `docker restart`, the inspect of its state and the host-side `docker top` of what runs in it. The answer is a pristine sandbox: tini (the host PID 4242) and its one child, `sleep infinity`.
export const FAKE_TINI_PID = 4242;
export const STATE_FORMAT = "{{.State.Running}} {{.State.Pid}}";
export interface FakeAnswer { exitCode: number; stdout: string; stderr: string }
const ok = (stdout: string): FakeAnswer => ({ exitCode: 0, stdout, stderr: "" });

/** The pristine sandbox's rows for `docker top <c> -eo pid,ppid,args`. */
export const PRISTINE_TOP = `PID PPID COMMAND\n${String(FAKE_TINI_PID)} 0 /usr/bin/tini -- sleep infinity\n${String(FAKE_TINI_PID + 1)} ${String(FAKE_TINI_PID)} sleep infinity\n`;

/** The answer to a restart, state or top call, or undefined for any other call. */
export function answerSandboxRestart(args: readonly string[], top: string = PRISTINE_TOP): FakeAnswer | undefined {
  if (args[0] === "restart") return ok("");
  if (args[0] === "inspect" && args.includes(STATE_FORMAT)) return ok(`true ${String(FAKE_TINI_PID)}\n`);
  if (args[0] === "top") return ok(top);
  return undefined;
}
