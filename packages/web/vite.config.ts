import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
 base: "./", plugins: [react()],
 build: {
  assetsInlineLimit: 0, outDir: "dist/app", manifest: true,
  rollupOptions: {
   preserveEntrySignatures: "allow-extension",
   output: {
    // RULING Q42: preserve CSP initialization order and keep shared React out of deferred Markdown.
    strictExecutionOrder: true,
    codeSplitting: { groups: [
     // v1.2 learning: its contracts load with the lazy project and How we work screens that use them, not at startup (the initial JS budget).
     { name: "contracts-learning", test: /[\\/]packages[\\/]contracts[\\/](?:src|dist)[\\/]project-learning\.[jt]s$/, priority: 110, includeDependenciesRecursively: false },
     { name: "contracts", test: id => id.includes("/packages/contracts/") || id.includes("/node_modules/zod/"), priority: 100 },
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
