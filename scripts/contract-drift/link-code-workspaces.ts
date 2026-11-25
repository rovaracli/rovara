// Installs the Code workspace packages that Code's contracts import into a Cloud tree's node_modules, so that tree's own contract-drift tool (which only exports packages/contracts) can load
// them. The deployed-drift gate runs this from the PIPELINE tree before it runs the check in a deployed or candidate tree that predates the fix in run.ts.
//   node scripts/contract-drift/link-code-workspaces.ts <cloud-tree> <code-clone> <code-sha>
// Exit 0 when every package is installed and built; any other exit is a failure (the gate fails closed on it).
import path from "node:path";
import { installContractsWorkspaces } from "./code-workspaces.ts";

const [tree, repo, sha] = process.argv.slice(2);
if (tree === undefined || repo === undefined || sha === undefined || !/^[0-9a-f]{40}$/u.test(sha)) {
  process.stderr.write("usage: node link-code-workspaces.ts <cloud-tree> <code-clone> <40-hex code sha>\n");
  process.exit(2);
}
try {
  const root = path.resolve(tree);
  const installed = installContractsWorkspaces(repo, sha, path.join(root, "node_modules"), root);
  process.stdout.write(`Code workspace packages for the contracts: ${installed.length === 0 ? "none needed" : installed.map((workspace) => workspace.name).join(", ")}\n`);
} catch (error) {
  process.stderr.write(`link-code-workspaces: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
