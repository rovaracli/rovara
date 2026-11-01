// The files a synthesis kit carries besides its entry: the map from each Lambda function to the code package it runs, and those packages (the release's own signed zips, copied in).
import { z } from "zod";

export const KIT_CODE_MAP_FILE = "code-map.json";
export const kitCodeFile = (assetId: string): string => `code/${assetId}.zip`;

const AssetId = z.string().regex(/^[a-f0-9]{64}$/);
export const CodeMapSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Every Lambda function of the app (construct path) and the id of its code package, sorted by path. Lambda code does not depend on the edition or the install's settings. */
    functions: z.array(z.object({ path: z.string().min(1).max(500), assetId: AssetId }).strict()).max(500),
  })
  .strict();
export type CodeMap = z.infer<typeof CodeMapSchema>;
