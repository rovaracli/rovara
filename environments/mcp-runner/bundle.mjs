// Bundles one runner program (serve, fetch or install) into one file, with everything it imports inside, so the image holds no node_modules at all. The Dockerfile runs it and
// tests/unit/mcp-runner/runner-image.test.ts builds with the same options. Plain JavaScript: it runs with the esbuild `npm ci` installed, before anything of the repository is built.
//
// The programs import Rovara Code's contracts through `@rovara-code/contracts` (the vendored copy, convergence W0-3). Cloud's own contracts package says in its package.json that its modules are
// free of side effects, so the bundler keeps only what a program uses. Code's package.json does not say it (it is read only), and the bundle would then hold Code's whole barrel and the TypeScript compiler
// one of its files imports. The plugin says it for Code's contract files, as Cloud's package does for its own.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const CODE_CONTRACT_FILES = /[\\/]vendor[\\/]rovara-code[\\/]packages[\\/]contracts[\\/](?:src|dist)[\\/]/u;

const codeContractsHaveNoSideEffects = {
  name: "rovara-code-contracts-have-no-side-effects",
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData === "resolved-by-the-plugin") return undefined;
      const resolved = await builder.resolve(args.path, { importer: args.importer, namespace: args.namespace, resolveDir: args.resolveDir, kind: args.kind, pluginData: "resolved-by-the-plugin" });
      if (resolved.errors.length > 0) return resolved;
      return CODE_CONTRACT_FILES.test(resolved.path) ? { ...resolved, sideEffects: false } : undefined;
    });
  },
};

/** The options of one program's bundle. */
export function runnerBundleOptions(entry, outfile) {
  return {
    entryPoints: [entry], bundle: true, platform: "node", target: "node22", format: "esm", legalComments: "none", outfile, logLevel: "silent",
    banner: { js: "import { createRequire as __rovaraCreateRequire } from 'node:module'; const require = __rovaraCreateRequire(import.meta.url);" },
    // One of Code's contract files imports the TypeScript compiler; nothing a program calls reaches it, and the bundler drops the import with the file's unused code. Marked external, a program that DID keep
    // the import would show it as an import of a package (tests/unit/mcp-runner/runner-image.test.ts refuses any), instead of dragging the compiler into the image.
    external: ["typescript"],
    plugins: [codeContractsHaveNoSideEffects],
  };
}

// node environments/mcp-runner/bundle.mjs <source name> <output name> ...: bundles packages/broker/src/mcp-runner/<source>.ts to /opt/mcp-runner/<output>.mjs, once per pair.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const pairs = process.argv.slice(2);
  for (let index = 0; index < pairs.length; index += 2) await build(runnerBundleOptions(`packages/broker/src/mcp-runner/${pairs[index]}.ts`, `/opt/mcp-runner/${pairs[index + 1]}.mjs`));
}
