// Builds the release signer program (scripts/release/sign-bundle.ts) the way the `sign` job of .github/workflows/release.yml does: one file, with zod, the KMS client and the packages the signer
// installs left external. Plain JavaScript on purpose: the job runs it with the esbuild this folder installs, before anything else of the repository is built.
//
// The program reads Cloud's contracts and, through them, Rovara Code's contracts (the vendored copy under vendor/rovara-code, convergence W0-3). Cloud's contracts package says in its
// package.json that its modules are free of side effects, so the bundler drops what the signer does not use. Code's package.json does not say it (it is read only), and the signer's bundle would
// keep every module's imports (`typescript`, `@aws-crypto/sha256-js`: packages the signer does not install). The plugin below says it for Code's contract sources, as Cloud's package does for its own.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const CODE_CONTRACT_SOURCES = /[\\/]vendor[\\/]rovara-code[\\/]packages[\\/]contracts[\\/]src[\\/]/u;

const codeContractsHaveNoSideEffects = {
  name: "rovara-code-contracts-have-no-side-effects",
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData === "resolved-by-the-plugin") return undefined;
      const resolved = await builder.resolve(args.path, { importer: args.importer, namespace: args.namespace, resolveDir: args.resolveDir, kind: args.kind, pluginData: "resolved-by-the-plugin" });
      if (resolved.errors.length > 0 || !CODE_CONTRACT_SOURCES.test(resolved.path)) return resolved.errors.length > 0 ? resolved : undefined;
      return { ...resolved, sideEffects: false };
    });
  },
};

/** The options of the signer build; a test builds with the same ones in memory (`write: false`). */
export function signerBuildOptions() {
  return {
    entryPoints: ["scripts/release/sign-bundle.ts"], bundle: true, platform: "node", format: "esm", target: "node22",
    alias: { "@agentx/cloud-contracts": "./packages/cloud-contracts/src/index.ts", "@rovara-code/contracts": "./vendor/rovara-code/packages/contracts/src/index.ts" },
    external: ["zod", "@aws-sdk/client-kms", "typescript", "@rovara/audit-verifier", "@aws-crypto/sha256-js"],
    plugins: [codeContractsHaveNoSideEffects],
    outfile: "scripts/release/signer/dist/sign-bundle.mjs",
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await build(signerBuildOptions());
