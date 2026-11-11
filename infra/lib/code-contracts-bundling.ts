// STOPGAP (convergence W0-3, review H3): see scripts/vendor/mark-code-contracts-pure.mjs. Every NodejsFunction runs it before esbuild, so a Lambda bundles what it uses of Rovara Code's contracts and
// not the whole barrel and the TypeScript compiler. Remove with that script once the pinned Code declares `sideEffects: false` itself.
import { join } from "node:path";

/** The `beforeBundling` command of a Lambda bundle: `inputDir` is the project root the bundler works in. */
export const markCodeContractsPureCommand = (inputDir: string): string => `node ${JSON.stringify(join(inputDir, "scripts", "vendor", "mark-code-contracts-pure.mjs"))} ${JSON.stringify(inputDir)}`;
