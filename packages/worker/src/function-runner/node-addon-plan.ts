// Slice 4 X2 (Node): what to do about x86_64 `.node` addons in a function package. PLAN ONLY (the addendum puts npm fetching in a later slice): this names, per npm package,
// one of three outcomes, from files alone.
//   - "arm64-present": the package already ships an arm64 twin of every x86_64 addon (prebuildify `prebuilds/linux-arm64/`, a napi-rs `*.linux-arm64-gnu.node`, node-pre-gyp
//     `lib/binding/.../linux-arm64/`). Node picks the binary by process.arch at load time, so nothing is swapped; the x86 files are dead weight.
//   - "swap-planned": the package is an optional-dependency variant (`@napi-rs/x-linux-x64-gnu`, `@img/sharp-linux-x64`, `@esbuild/linux-x64`) and another installed package
//     LISTS its arm64 counterpart in `optionalDependencies`. The plan names the exact package and version to fetch (same version as the x64 variant) and the folder to drop.
//   - "qemu": nothing lists an arm64 binary (a first-party addon, a native dependency without prebuilt arm64): the qemu path (lane X3).
// package.json files are hostile text: names are validated, sizes capped, and a name that is not a plain npm name is never planned for fetching.
import { classifyNative, displayPath, readSmallText, type NodeAddon, type PackageFileInput } from "./native-classify.js";

export type NodePlanStatus = "arm64-present" | "swap-planned" | "qemu";

export interface NodeSwapStep {
  /** An npm package to fetch from the registry and unpack at `node_modules/<name>`. */
  readonly fetch: { readonly name: string; readonly version: string };
  /** The x86_64 variant folder to remove once the arm64 one is in place. */
  readonly drop: string;
}

export interface NodePackagePlan {
  /** npm name ("@napi-rs/canvas-linux-x64-gnu"), or "" for an addon outside node_modules. */
  readonly name: string;
  readonly version: string;
  readonly status: NodePlanStatus;
  readonly detail: string;
  readonly fallback: "none" | "qemu";
  /** Sanitised paths of the x86_64 addons. */
  readonly addons: readonly string[];
  readonly step?: NodeSwapStep;
}

export interface NodePlan {
  readonly packages: readonly NodePackagePlan[];
  /** Every x86_64 addon is covered (arm64-present or swap-planned). */
  readonly allPlanned: boolean;
}

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]{0,213}\/)?[a-z0-9][a-z0-9._~-]{0,213}$/u;
const NPM_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/u;
const PACKAGE_JSON_BYTES = 512 * 1024;

/** The x64 spelling of a path or package name with its arm64 twin: `linux-x64-gnu` to `linux-arm64-gnu`. Undefined when there is no x64 token. */
export function arm64Twin(text: string): string | undefined {
  const twin = text.replace(/(^|[-_./])x64(?=$|[-_./])/u, "$1arm64");
  return twin === text ? undefined : twin;
}

interface Found { readonly root: string; readonly name: string }

/** `node_modules/@scope/name` or `node_modules/name` holding `path`, taking the innermost node_modules. */
function packageOf(path: string): Found | undefined {
  const parts = path.split("/");
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length) return undefined;
  const first = parts[at + 1]!;
  if (first.startsWith("@")) {
    if (at + 2 >= parts.length) return undefined;
    return { root: parts.slice(0, at + 3).join("/"), name: `${first}/${parts[at + 2]!}` };
  }
  return { root: parts.slice(0, at + 2).join("/"), name: first };
}

interface Manifest { readonly name: string; readonly version: string; readonly optional: ReadonlyMap<string, string> }

function readManifest(file: PackageFileInput | undefined, fallbackName: string): Manifest {
  const empty: Manifest = { name: fallbackName, version: "", optional: new Map() };
  if (file === undefined) return empty;
  const text = readSmallText(file, PACKAGE_JSON_BYTES);
  if (text === undefined) return empty;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return empty; }
  if (typeof parsed !== "object" || parsed === null) return empty;
  const json = parsed as { name?: unknown; version?: unknown; optionalDependencies?: unknown };
  const optional = new Map<string, string>();
  if (typeof json.optionalDependencies === "object" && json.optionalDependencies !== null) {
    for (const [name, range] of Object.entries(json.optionalDependencies as Record<string, unknown>).slice(0, 200)) if (typeof range === "string" && NPM_NAME.test(name)) optional.set(name, range);
  }
  return { name: typeof json.name === "string" && NPM_NAME.test(json.name) ? json.name : fallbackName, version: typeof json.version === "string" && NPM_VERSION.test(json.version) ? json.version : "", optional };
}

export function planNodeAddons(files: readonly PackageFileInput[]): NodePlan {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const addons = new Map<string, { raw: string; arch: NodeAddon["arch"] }>();
  // classifyNative lists sanitised paths; keep the raw ones by classifying addon files one by one (only `.node` files, a small set).
  for (const file of files) {
    if (!file.path.toLowerCase().endsWith(".node")) continue;
    const result = classifyNative([file]);
    const addon = result.nodeAddons[0];
    if (addon !== undefined) addons.set(file.path, { raw: file.path, arch: addon.arch });
  }
  const x86 = [...addons.values()].filter((addon) => addon.arch !== "arm64");

  // Group by owning npm package.
  const groups = new Map<string, { found: Found | undefined; paths: string[] }>();
  for (const addon of x86) {
    const found = packageOf(addon.raw);
    const key = found?.root ?? "";
    const group = groups.get(key) ?? { found, paths: [] };
    group.paths.push(addon.raw);
    groups.set(key, group);
  }

  // Every optionalDependencies list of every installed package, by the dependency it names.
  const listedBy = new Map<string, string[]>();
  for (const file of files) {
    if (!file.path.endsWith("/package.json") || !file.path.includes("node_modules/")) continue;
    const found = packageOf(file.path);
    if (found === undefined || file.path !== `${found.root}/package.json`) continue;
    for (const name of readManifest(file, found.name).optional.keys()) listedBy.set(name, [...(listedBy.get(name) ?? []), found.root]);
  }

  const packages: NodePackagePlan[] = [];
  for (const group of groups.values()) {
    const shown = group.paths.slice(0, 20).map(displayPath);
    const found = group.found;
    if (found === undefined) {
      packages.push({ name: "", version: "", status: "qemu", detail: "first-party-addon", fallback: "qemu", addons: shown });
      continue;
    }
    const manifest = readManifest(byPath.get(`${found.root}/package.json`), found.name);
    const base = { name: manifest.name, version: manifest.version, addons: shown };
    // 1. Every x86_64 addon has an arm64 twin in the files.
    const covered = group.paths.every((path) => {
      const twin = arm64Twin(path);
      return twin !== undefined && addons.get(twin)?.arch === "arm64";
    });
    if (covered) { packages.push({ ...base, status: "arm64-present", detail: "arm64-twin-shipped", fallback: "none" }); continue; }
    // 2. An installed package lists the arm64 variant of this x64 variant.
    const twinName = arm64Twin(manifest.name);
    if (twinName !== undefined && NPM_NAME.test(twinName) && manifest.version !== "" && (listedBy.get(twinName)?.length ?? 0) > 0 && !byPath.has(`${arm64Twin(found.root) ?? "\0"}/package.json`)) {
      packages.push({ ...base, status: "swap-planned", detail: "listed-arm64-variant", fallback: "none", step: { fetch: { name: twinName, version: manifest.version }, drop: displayPath(found.root) } });
      continue;
    }
    if (twinName !== undefined && (listedBy.get(twinName)?.length ?? 0) > 0 && byPath.has(`${arm64Twin(found.root) ?? "\0"}/package.json`)) {
      packages.push({ ...base, status: "arm64-present", detail: "arm64-variant-installed", fallback: "none" });
      continue;
    }
    packages.push({ ...base, status: "qemu", detail: manifest.version === "" && twinName !== undefined ? "version-unknown" : "no-arm64-binary-listed", fallback: "qemu" });
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return { packages, allPlanned: packages.every((plan) => plan.status !== "qemu") };
}
