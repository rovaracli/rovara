// The LearningKeySource adapter (DEC 226, learning-route.ts): the company's OWN connected Anthropic account, held in the product
// key store as a company source of provider "anthropic" (sealed like the product keys: KMS envelope bound to install, company,
// owner, source and version; read only at the AWSCURRENT stage). A company admin connects, rotates and removes it through Cloud's
// settings routes; a project never holds one and can never link to it (product-keys.ts).
import type { LearningKeySource } from "./learning-route.js";
import type { ProductKeyStore } from "./product-keys.js";

export function storedLearningKeys(store: Pick<ProductKeyStore, "companySource" | "useKey">): LearningKeySource {
  return {
    async connected(iss, cid) { return (await store.companySource(iss, cid, "anthropic")) !== undefined; },
    async keyFor(iss, cid) {
      const source = await store.companySource(iss, cid, "anthropic");
      return source === undefined ? undefined : store.useKey(iss, cid, source);
    },
  };
}
