import { z } from "zod";

/** The AI companies Rovara can name behind a model. `other` is anything it does not recognise, and never counts as different from another company. */
export const MODEL_COMPANIES = ["anthropic", "openai", "google", "amazon", "meta", "mistral", "deepseek", "qwen", "cohere", "other"] as const;
export const ModelCompanySchema = z.enum(MODEL_COMPANIES);
