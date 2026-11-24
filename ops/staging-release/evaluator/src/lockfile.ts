// Rule J (plan v3 section 3 and section 9 (b)): a changed package-lock.json is AUTO-eligible only if every check holds.
// The lock is compared as data (old lock vs new lock, parsed JSON); npm is never run in the merged tree.
import type { Policy } from "./policy.ts";
import { InputError, asRecord, canonicalJson, deepEqual, field, isRecord, matchesAnyGlob, onlyKeys, hasOwn, parseJsonText } from "./util.ts";

const TOP_LEVEL_KEYS = ["name", "version", "lockfileVersion", "requires", "packages"] as const;

function packagesOf(lock: unknown, where: string): Record<string, unknown> {
  const root = asRecord(lock, where);
  onlyKeys(root, TOP_LEVEL_KEYS, where);
  return asRecord(field(root, "packages", where), `${where}.packages`);
}

function declaredNames(entry: unknown): string[] {
  if (!isRecord(entry)) return [];
  const names: string[] = [];
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const group = entry[key];
    if (isRecord(group)) names.push(...Object.keys(group));
  }
  return names;
}

function badResolved(resolved: unknown, host: string): string | null {
  if (typeof resolved !== "string") return "has no resolved URL";
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    return `resolved "${resolved}" is not a URL`;
  }
  if (!resolved.startsWith(`https://${host}/`) || url.protocol !== "https:" || url.hostname !== host || url.username !== "" || url.password !== "" || url.port !== "") {
    return `resolved "${resolved}" is not https://${host}/`;
  }
  return null;
}

/** Returns the list of failing checks (empty = rule J passes). Throws InputError for missing or unparsable input (the caller turns that into a MANUAL reason). */
export function checkLockfile(raw: unknown, changedPaths: readonly string[], policy: Policy, npmCiDryRun: unknown): string[] {
  const failures: string[] = [];
  const lockInput = asRecord(raw, "lock");
  onlyKeys(lockInput, ["old", "new"], "lock");
  const oldLock = parseJsonText(field(lockInput, "old", "lock"), "lock.old");
  const newLock = parseJsonText(field(lockInput, "new", "lock"), "lock.new");
  const oldRoot = asRecord(oldLock, "lock.old");
  const newRoot = asRecord(newLock, "lock.new");
  const oldPackages = packagesOf(oldLock, "lock.old");
  const newPackages = packagesOf(newLock, "lock.new");

  // 1. Nothing else from the manual list changed: no package.json anywhere, no .npmrc, no release scripts, no Dockerfile.
  for (const path of changedPaths) {
    if (path === policy.lockfile.path) continue;
    if (matchesAnyGlob(path, policy.lockfile.blockingGlobs)) failures.push(`J1: "${path}" changed together with the lock`);
  }

  // 2. lockfileVersion, the root entry and the workspace links are unchanged.
  if (oldRoot.lockfileVersion !== policy.lockfile.lockfileVersion || newRoot.lockfileVersion !== policy.lockfile.lockfileVersion) {
    failures.push(`J2: lockfileVersion must stay ${policy.lockfile.lockfileVersion} (old ${String(oldRoot.lockfileVersion)}, new ${String(newRoot.lockfileVersion)})`);
  }
  for (const key of ["name", "version", "requires"]) {
    if (!deepEqual(oldRoot[key], newRoot[key])) failures.push(`J2: top-level "${key}" changed`);
  }
  if (!hasOwn(oldPackages, "") || !hasOwn(newPackages, "")) failures.push('J2: packages[""] is missing');
  else if (!deepEqual(oldPackages[""], newPackages[""])) failures.push('J2: the root packages[""] entry changed (scripts, workspaces, overrides or dependency ranges)');
  const links = (packages: Record<string, unknown>): string =>
    canonicalJson(Object.keys(packages).filter((key) => isRecord(packages[key]) && packages[key].link === true).sort().map((key) => [key, (packages[key] as Record<string, unknown>).resolved ?? null]));
  if (links(oldPackages) !== links(newPackages)) failures.push("J2: the set of workspace link entries changed");

  // 3. Every added or changed entry.
  const keys = [...new Set([...Object.keys(oldPackages), ...Object.keys(newPackages)])].sort();
  const declared = new Set<string>();
  for (const key of Object.keys(newPackages)) {
    if (key === "" || !key.includes("node_modules/")) for (const name of declaredNames(newPackages[key])) declared.add(name);
  }
  for (const key of keys) {
    if (key === "") continue;
    const before = hasOwn(oldPackages, key) ? oldPackages[key] : undefined;
    const after = hasOwn(newPackages, key) ? newPackages[key] : undefined;
    if (deepEqual(before, after)) continue;
    if (after === undefined) {
      // 4. Removed: not a name a workspace (or the root) manifest still declares.
      const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      if (match !== null && declared.has(match[1] as string)) failures.push(`J4: "${key}" was removed but a workspace manifest still names it`);
      if (!key.includes("node_modules/")) failures.push(`J3: workspace entry "${key}" was removed`);
      continue;
    }
    if (!key.includes("node_modules/")) {
      failures.push(`J3: workspace entry "${key}" changed (a manifest-level change)`);
      continue;
    }
    if (!isRecord(after)) {
      failures.push(`J3: "${key}" is not an object`);
      continue;
    }
    if (after.link === true) failures.push(`J3: "${key}" is a link entry`);
    const resolvedProblem = badResolved(after.resolved, policy.lockfile.registryHost);
    if (resolvedProblem !== null) failures.push(`J3: "${key}" ${resolvedProblem}`);
    if (typeof after.integrity !== "string" || !policy.lockfile.integrity.test(after.integrity)) failures.push(`J3: "${key}" has no sha512 integrity`);
    if (hasOwn(after, "hasInstallScript") && after.hasInstallScript !== false) failures.push(`J3: "${key}" has an install script`);
    const newBin = hasOwn(after, "bin") ? after.bin : undefined;
    if (newBin !== undefined) {
      const oldBin = isRecord(before) && hasOwn(before, "bin") ? before.bin : undefined;
      const oldNames = isRecord(oldBin) ? Object.keys(oldBin) : [];
      const newNames = isRecord(newBin) ? Object.keys(newBin) : ["<non-object bin>"];
      const added = newNames.filter((name) => !oldNames.includes(name));
      if (added.length > 0) failures.push(`J3: "${key}" has a new bin entry (${added.join(", ")})`);
      else if (isRecord(oldBin) && isRecord(newBin)) {
        for (const name of newNames) if (oldBin[name] !== newBin[name]) failures.push(`J3: "${key}" bin "${name}" points somewhere else`);
      }
    }
  }

  // 4. The lock is consistent with the unchanged manifests: Build ran npm ci --dry-run --ignore-scripts.
  const dryRun = asRecord(npmCiDryRun, "npmCiDryRun");
  if (dryRun.ok !== true) failures.push("J4: npm ci --dry-run --ignore-scripts did not pass");
  return failures;
}

export function lockInputRequired(changedPaths: readonly string[], lockPath: string): boolean {
  return changedPaths.includes(lockPath);
}

export { InputError };
