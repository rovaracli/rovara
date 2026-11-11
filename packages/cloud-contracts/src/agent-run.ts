import { z } from "zod";
import { utf8 } from "@rovara-code/contracts";

export function boundedBytes(max: number) {
  return z.string().min(1).refine((text) => utf8.encode(text).length <= max, `must be at most ${max} bytes`);
}
