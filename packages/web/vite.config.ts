import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ base: "./", plugins: [react()], build: { outDir: "dist/app", manifest: true, rollupOptions: { output: { manualChunks(id) { if (id.includes("/screens/builder/")) return "builder"; if (id.includes("/screens/admin/")) return "admin"; if (id.includes("/screens/chains/")) return "chains"; if (/react-markdown|remark-|micromark|mdast|hast/.test(id)) return "markdown"; } } } } });
