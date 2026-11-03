// The broker's one Amazon Bedrock control-plane read: whether the account has enabled a foundation model (`bedrock:GetFoundationModelAvailability`, no resource-level scope exists for it). Ids and statuses only come out.
import { BedrockClient, GetFoundationModelAvailabilityCommand } from "@aws-sdk/client-bedrock";
import type { AvailabilityProbe } from "./usable-models.js";

export function bedrockAvailabilityProbe(client: Pick<BedrockClient, "send">): AvailabilityProbe {
  return async (foundationModelId) => {
    const response = await client.send(new GetFoundationModelAvailabilityCommand({ modelId: foundationModelId }));
    return { agreement: response.agreementAvailability?.status ?? null, authorization: response.authorizationStatus ?? null };
  };
}

export const newBedrockClient = (region: string | undefined): BedrockClient => new BedrockClient({ ...(region === undefined ? {} : { region }), maxAttempts: 2 });
