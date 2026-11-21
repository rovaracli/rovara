import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
function probe(expression: string): unknown {
 return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `import { capturePlan, localBaseUrl } from './scripts/capture-design-system-v2.mjs'; console.log(JSON.stringify(${expression}));`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as unknown;
}
it("plans exactly 104 distinct base images across 26 scenes, two viewports and both themes", () => {
 const targets = probe("capturePlan()") as { scene: string; width: number; height: number; theme: string; filename: string }[];
 expect(targets).toHaveLength(104);expect(new Set(targets.map(target => target.filename)).size).toBe(104);
 expect(new Set(targets.map(target => target.scene)).size).toBe(26);
 expect(new Set(targets.map(target => `${String(target.width)}x${String(target.height)}`))).toEqual(new Set(["1440x1000", "390x844"]));
 expect(new Set(targets.map(target => target.theme))).toEqual(new Set(["light", "dark"]));
});
it("allows only a dedicated loopback HTTP host, never a remote host, credentials or an external protocol", () => {
 for (const url of ["http://127.0.0.1:43125", "http://localhost:43125/"]) expect(probe(`localBaseUrl(${JSON.stringify(url)}).origin`)).toBe(url.replace(/\/$/, ""));
 for (const url of ["https://example.com", "http://127.0.0.1.example.com:43125", "file:///tmp/page", "http://name:password@127.0.0.1:43125", "http://127.0.0.1:43125/app", "http://127.0.0.1:43125/?scene=x"]) {
  expect(() => probe(`localBaseUrl(${JSON.stringify(url)})`)).toThrow();
 }
});
