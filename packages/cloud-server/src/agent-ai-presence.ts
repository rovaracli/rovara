// Lead 4 L4-CW: ONE yes/no fact for a company: "the AI for its agents is connected". It reads what the company's admin saved under "AI for your agents" (agent-ai-routes.ts: the choice in the Companies table, and the
// product key store's connection state) and answers true, false, or null when Cloud cannot tell. It is the same reading the gateway acts on for the saved choice, reduced to one boolean:
//
//   Rovara's AI       true (nothing to connect; the gateway says at the first call if the install has it off)
//   no choice        own Anthropic, then own Bedrock, then Rovara AI (DEC 254zzz279 / R-1); unreadable required connections stay null
//   own Anthropic key true while the company's key is stored and available
//   own Bedrock       true while its role is connected and available
//   anything else     null (a source this code does not know is never "missing")
//
// Never the key, the provider, the source or the model: the answer is a boolean or null, and callers put only that into an answer. The company is the argument; callers take it from Code's live access check,
// never from the browser. A throw anywhere is "cannot tell" (null), never "missing".
import { effectiveAgentSource } from "./company-store.js";
import { anthropicKeyConnected, bedrockForDefault } from "./agent-ai-routes.js";
import { bedrockConnected } from "./bedrock-byo-routes.js";
import type { RouteContext } from "./routes.js";

export async function agentAiConnected(context: Pick<RouteContext, "company" | "productAi">, companyId: string): Promise<boolean | null> {
  const company = context.company;
  if (company === undefined) return null;
  let source: string | undefined;
  try { source = (await company.store.agentAi(companyId))?.source; } catch { return null; }
  const asked = context as RouteContext;
  // R-1: presence follows the same own-key/Bedrock/default resolution as admission and the source readout.
  // Only a confirmed absence of connections means Rovara AI; an unreadable connection is unknown.
  if (source === undefined) {
    const keyConnected = await anthropicKeyConnected(asked, companyId);
    const bedrock = keyConnected === false ? await bedrockForDefault(asked, companyId, await bedrockConnected(asked, companyId)) : null;
    const effective = effectiveAgentSource({ saved: undefined, exempt: false, keyConnected, bedrockConnected: bedrock });
    return effective.source === null ? null : true;
  }
  if (source === "rovara") return true;
  if (source === "anthropic_key") return anthropicKeyConnected(asked, companyId);
  if (source === "bedrock_byo") return bedrockConnected(asked, companyId);
  return null;
}
