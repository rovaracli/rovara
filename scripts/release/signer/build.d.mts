import type { BuildOptions } from "esbuild";
/** The esbuild options of the release signer's build (see build.mjs); a test builds with the same ones in memory. */
export function signerBuildOptions(): BuildOptions;
