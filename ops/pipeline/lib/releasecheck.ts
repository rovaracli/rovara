// The release check (ported from releaseCheckedDeploy, infra/lib/cloud-release-pipeline.ts): while the web/app change sets execute, the live
// address is asked every second; any 5xx or failed connection fails the release, even when the deploy itself succeeded.
import type { Ports } from "../types.ts";

export interface ReleaseCheck { stop(): Promise<{ probes: number; failures: string[] }> }

export function startReleaseCheck(ports: Ports, base: string, paths: readonly string[], intervalMs: number): ReleaseCheck {
  let running = true;
  let probes = 0;
  const failures: string[] = [];
  const loop = (async () => {
    while (running) {
      for (const path of paths) {
        const status = await ports.http.get(`${base}${path}`, 10_000).then((answer) => answer.status, () => 0);
        probes += 1;
        if (status >= 500 || status === 0) failures.push(`${ports.clock.now().toISOString().slice(11, 19)} ${path} ${status === 0 ? "000" : status}`);
      }
      if (running) await ports.clock.sleep(intervalMs);
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return { probes, failures };
    },
  };
}

/** The web stack's CloudUrl output without its `/app` suffix, or null when there is none yet (the first deploy of the stack). */
export function baseUrlFromOutputs(outputs: Record<string, string> | undefined): string | null {
  const url = outputs?.CloudUrl;
  if (url === undefined || url === "" || url === "None") return null;
  return url.replace(/\/app$/u, "");
}
