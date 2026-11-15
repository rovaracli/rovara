/** Existing Bedrock alias folding, with the shared case/whitespace identity policy. */
export function normalizeBedrockModel(model: string): string {
  let text = model.trim().slice(model.trim().indexOf("/") + 1).toLowerCase();
  if (text.includes(".")) text = text.replace(/^(?:(?:us-gov|us|eu|apac|global|jp|au|in|ca)\.)?[a-z0-9-]+\./u, "");
  return text.replace(/(?:-\d{8})?(?:-v\d+(?::\d+)?)?$|@\d+$/u, "");
}
export function normalizedModel(provider: string, model: string): string {
  const text = model.trim().toLowerCase();
  return provider === "bedrock" ? normalizeBedrockModel(text) : provider === "gemini" ? text.replace(/^gemini\//u, "") : text;
}
export const identityKey = (provider: string, model: string): string => JSON.stringify([provider, normalizedModel(provider, model)]);
