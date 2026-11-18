// Lead 4 L4-CW: ONE yes/no fact for a company: "the AI for its agents is connected". It reads what the company's admin saved under "AI for your agents" (agent-ai-routes.ts: the choice in the Companies table, and the
// product key store's connection state) and answers true, false, or null when Cloud cannot tell. It is the same reading the gateway acts on for the saved choice, reduced to one boolean:
//
//   Rovara's AI       true (nothing to connect; the gateway says at the first call if the install has it off)
//   no choice, exempt true while nothing is connected (Rovara's AI is the default, DEC 254zzz3(1)); own key / own Bedrock as below
//   own Anthropic key true while the company's key is stored and available (no saved choice reads the same: company-key mode, DEC 236)
//   own Bedrock       true while its role is connected and available
//   anything else     null (a source this code does not know is never "missing")
//
// Never the key, the provider, the source or the model: the answer is a boolean or null, and callers put only that into an answer. The company is the argument; callers take it from Code's live access check,
// never from the browser. A throw anywhere is "cannot tell" (null), never "missing".
import { anthropicKeyConnected, bedrockForDefault } from "./agent-ai-routes.js";
import { effectiveAgentSource } from "./company-store.js";
import { bedrockConnected } from "./bedrock-byo-routes.js";
import type { RouteContext } from "./routes.js";

export async function agentAiConnected(context: Pick<RouteContext, "company" | "productAi">, companyId: string): Promise<boolean | null> {
  const company = context.company;
  if (company === undefined) return null;
  let source: string | undefined;
  try { source = (await company.store.agentAi(companyId))?.source; } catch { return null; }
  const asked = context as RouteContext;
  // DEC 254zzz3(1): an exempt company with no saved choice is on its own key, its own Bedrock, else Rovara's AI (nothing to connect).
  if (source === undefined && company.rovaraAiExempt?.has(companyId) === true) {
    const keyConnected = await anthropicKeyConnected(asked, companyId);
    const bedrock = keyConnected === false ? bedrockForDefault(asked, await bedrockConnected(asked, companyId)) : null;
    const effective = effectiveAgentSource({ saved: undefined, exempt: true, keyConnected, bedrockConnected: bedrock });
    if (effective.source === "rovara") return true;
    if (effective.source === "anthropic_key") return true;
    if (effective.source === "bedrock_byo") return true;
    return null;
  }
  if (source === undefined || source === "anthropic_key") return anthropicKeyConnected(asked, companyId);
  if (source === "rovara") return true;
  if (source === "bedrock_byo") return bedrockConnected(asked, companyId);
  return null;
}
