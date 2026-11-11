import type { BuildOptions } from "esbuild";
/** The esbuild options of one runner program's bundle (see bundle.mjs). */
export function runnerBundleOptions(entry: string, outfile: string): BuildOptions;
