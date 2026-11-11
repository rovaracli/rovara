import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
 base: "./", plugins: [react()],
 build: {
  assetsInlineLimit: 0, outDir: "dist/app", manifest: true,
  rollupOptions: {
   preserveEntrySignatures: "allow-extension",
   // Rovara Code's built contracts (vendor/rovara-code, reached through @rovara-code/contracts) are side-effect free, as Cloud's own contracts package says it is in its package.json. Code's
   // package.json does not (it is read only, convergence W0-3), so say it here: otherwise every module of Code's barrel, the Node-only ones and their `node:` imports included, would be kept.
   treeshake: { moduleSideEffects: (id: string) => !/[\\/]vendor[\\/]rovara-code[\\/]packages[\\/]contracts[\\/]dist[\\/]/u.test(id) },
   output: {
    // RULING Q42: preserve CSP initialization order and keep shared React out of deferred Markdown.
    strictExecutionOrder: true,
    // No "contracts" group (removed 2026-10-31): it forced every contract module and zod into one chunk that every page loads, so the schemas only a lazy screen
    // needs (decision cards, setup proposal, intake, loaded knowledge, ...) counted against the initial JavaScript budget. Without it a contract module lands in the
    // chunk of the first route that needs it, or in a shared chunk. tests/contract/web-bundle-budget.test.ts holds the lazy-only strings out of the initial files.
    codeSplitting: { groups: [
     { name: "react", test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, priority: 90 },
     { name: "markdown", test: /react-markdown|remark-|micromark|mdast|hast/, priority: 80, includeDependenciesRecursively: false },
     { name: "builder", test: "/screens/builder/", includeDependenciesRecursively: false },
     { name: "admin", test: "/screens/admin/", includeDependenciesRecursively: false },
     { name: "chains", test: "/screens/chains/", includeDependenciesRecursively: false },
    ] },
   },
  },
 },
});
