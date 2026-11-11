import { z } from "zod";
import { digest, id } from "@rovara-code/contracts";

export const E2EApplicationSelectionFingerprintSchema = z.object({ selectionDigest: digest, intentDigest: digest, executableTargetIds: z.array(id(80)).max(12), runtimeRowsDigest: digest }).strict();
