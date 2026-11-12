// Convergence lane A3: Cloud's private adapters on Rovara Code's ports (model keys and model providers). The generic S3 objects and Secrets Manager secrets adapters are public, in Code
// (`@rovara-code/broker` plugins `object-storage-s3` and `secrets-aws`, owner decision 72 O2), and reach Cloud with the next vendor pin. Nothing here is wired into a Lambda yet: the
// composition root (`cloud/app`) registers them when the switch lanes land. Conformance: tests/conformance/adapters/.
export { createCloudModelKeyStore, installModelKeyArns, CloudModelKeyError, type CloudModelKeyStoreOptions, type ModelKeySecretsClient } from "./model-keys/secrets-manager.js";
export { cloudBedrockRoleProvider, companyBedrockProviders, BEDROCK_ROLE_PROBLEM, type CloudBedrockRoleOptions, type CompanyBedrockRoleSource, type RoleStsClient } from "./model-provider/bedrock-role.js";
export { cloudLiteLlmProvider, LITELLM_PROVIDER_ID, type CloudLiteLlmOptions, type LiteLlmTaskContext } from "./model-provider/litellm.js";
export { cloudOpenRouterProvider } from "./model-provider/openrouter.js";
export { cloudCatalogPrices } from "./model-provider/catalog-prices.js";
