import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DOCKER_DATA_DIRECTORY, RUNTIME_BACKING_DIRECTORY } from "./devcontainer-policy.js";

/**
 * What the worker keeps on the workspace volume that is not the project's (ruling R56): its manifest, conversation index,
 * operation journal and check history (`.agentx`) and Pi's saved transcripts (`agent-sessions`). The worker reads these
 * as its own state. Task code runs as the same user in a container that mounts the workspace, so each task container
 * hides them behind an empty mount, or code could forge what the worker then trusts.
 */
export const WORKER_STATE_DIRECTORIES = [".agentx", "agent-sessions"] as const;

/**
 * The folders of the workspace volume a task container must not see, as absolute paths: the worker's state (made if it
 * is missing, so a task cannot create the folder first) and the folders the boot script owns (hidden where they exist:
 * Docker's data root and the verifier's runtime). A root that does not exist has nothing to hide.
 */
export async function hiddenWorkspaceDirectories(rootPath: string): Promise<string[]> {
  const root = resolve(rootPath);
  if ((await stat(root).catch(() => undefined))?.isDirectory() !== true) return [];
  const hidden: string[] = [];
  for (const name of WORKER_STATE_DIRECTORIES) {
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
    hidden.push(join(root, name));
  }
  for (const name of [DOCKER_DATA_DIRECTORY, RUNTIME_BACKING_DIRECTORY]) {
    const path = join(root, name);
    if ((await stat(path).catch(() => undefined))?.isDirectory() === true) hidden.push(path);
  }
  return hidden;
}
