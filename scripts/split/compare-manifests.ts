// Proves that two repositories place the shared declarations in the same files. Each manifest is what `split-developer.ts --manifest` wrote: for each of
// the two files, every declaration name and the file it lands in. Every name in the public manifest (the one made with the shared config only) must be in
// the private manifest, in the same file. Names only the private manifest has are the private overlay's and are not compared.
//   node scripts/split/compare-manifests.ts <public-manifest.json> <private-manifest.json>
import { readFileSync } from "node:fs";

type Manifest = Record<string, Record<string, string>>;

export function compareManifests(shared: Manifest, other: Manifest): { compared: number; differing: string[]; absent: string[] } {
  let compared = 0;
  const differing: string[] = [];
  const absent: string[] = [];
  for (const [file, names] of Object.entries(shared)) {
    for (const [name, home] of Object.entries(names)) {
      const there = other[file]?.[name];
      if (there === undefined) { absent.push(`${file}: ${name}`); continue; }
      compared += 1;
      if (there !== home) differing.push(`${file}: ${name} is in ${home} here and ${there} there`);
    }
  }
  return { compared, differing, absent };
}

if (process.argv[1]?.endsWith("compare-manifests.ts")) {
  const [publicPath, privatePath] = process.argv.slice(2);
  if (publicPath === undefined || privatePath === undefined) throw new Error("usage: node scripts/split/compare-manifests.ts <public-manifest.json> <private-manifest.json>");
  const result = compareManifests(JSON.parse(readFileSync(publicPath, "utf8")) as Manifest, JSON.parse(readFileSync(privatePath, "utf8")) as Manifest);
  console.log(`${result.compared} shared names compared; ${result.differing.length} land in a different file; ${result.absent.length} are absent from the private file`);
  for (const line of result.differing) console.log(`DIFFERENT  ${line}`);
  for (const line of result.absent) console.log(`ABSENT     ${line}`);
  process.exit(result.differing.length === 0 ? 0 : 1);
}
