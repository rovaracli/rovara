// The LearningKeySource adapter (DEC 226, learning-route.ts): the company's OWN connected Anthropic account, held in the product
// key store as a company source of provider "anthropic" (sealed like the product keys: KMS envelope bound to install, company,
// owner, source and version; read only at the AWSCURRENT stage). A company admin connects, rotates and removes it through Cloud's
// settings routes; a project never holds one and can never link to it (product-keys.ts).
import type { LearningKeySource } from "./learning-route.js";
import type { ProductKeyStore } from "./product-keys.js";

export function storedLearningKeys(store: Pick<ProductKeyStore, "companySource" | "useKey">): LearningKeySource {
  return {
    // Only the Anthropic path is answered here: a company's Anthropic key is never sent to another provider's path.
    async connected(iss, cid, provider) { return provider === "anthropic" && (await store.companySource(iss, cid, "anthropic")) !== undefined; },
    async keyFor(iss, cid, provider) {
      if (provider !== "anthropic") return undefined;
      const source = await store.companySource(iss, cid, "anthropic");
      return source === undefined ? undefined : store.useKey(iss, cid, source);
    },
  };
}
