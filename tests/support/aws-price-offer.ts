// A small AWS Price List offer file (AmazonBedrockFoundationModels, one region) built from rows of [model name, usage type without its region prefix and "-Units", USD per million tokens], for the
// guard's price refresh. The shape is the real file's (products by SKU with attributes, terms.OnDemand with priceDimensions), fetched from
// https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/<region>/index.json (publication 2026-11-09T22:43:12Z).
export function awsPriceOffer(rows: ReadonlyArray<readonly [string, string, number]>): unknown {
  const products: Record<string, unknown> = {};
  const terms: Record<string, unknown> = {};
  rows.forEach(([model, usage, perMillion], index) => {
    const sku = `SKU${String(index)}`;
    products[sku] = { attributes: { model, usagetype: `USW2-MP:USW2_${usage}-Units`, servicename: `${model} (Amazon Bedrock Edition)` } };
    terms[sku] = { [`${sku}.T`]: { priceDimensions: { [`${sku}.T.D`]: { unit: "1M tokens", pricePerUnit: { USD: perMillion.toFixed(10) } } } } };
  });
  return { publicationDate: "2026-11-09T22:43:12Z", products, terms: { OnDemand: terms } };
}

/** Haiku 5.5 (standard, long-context and cache rows) and Fable 5.2, with the figures AWS's list carried on 2026-11-09. */
export const AWS_HAIKU_FABLE_OFFER = awsPriceOffer([
  ["Claude Haiku 5.5", "input_tokens_standard", 0.11], ["Claude Haiku 5.5", "output_tokens_standard", 0.55], ["Claude Haiku 5.5", "cache_read_tokens_standard", 0.011], ["Claude Haiku 5.5", "cache_write_tokens_standard", 0.1375],
  ["Claude Haiku 5.5", "input_tokens_long_ctx_standard", 0.55], ["Claude Haiku 5.5", "output_tokens_long_ctx_standard", 2.75], ["Claude Haiku 5.5", "cache_read_tokens_long_ctx_standard", 0.055], ["Claude Haiku 5.5", "cache_write_tokens_long_ctx_standard", 0.6875],
  ["Claude Haiku 5.5", "input_tokens_global_standard", 0.1], ["Claude Haiku 5.5", "output_tokens_global_standard", 0.5], ["Claude Haiku 5.5", "input_tokens_long_ctx_global_standard", 0.5], ["Claude Haiku 5.5", "output_tokens_long_ctx_global_standard", 2.5],
  ["Claude Fable 5.2", "input_tokens_standard", 8.8], ["Claude Fable 5.2", "output_tokens_standard", 44], ["Claude Fable 5.2", "cache_read_tokens_standard", 0.22], ["Claude Fable 5.2", "cache_write_tokens_standard", 11], ["Claude Fable 5.2", "cache_write_tokens_1h_standard", 17.6],
  ["Claude Fable 5.2", "input_tokens_global_standard", 8], ["Claude Fable 5.2", "output_tokens_global_standard", 40],
]);
