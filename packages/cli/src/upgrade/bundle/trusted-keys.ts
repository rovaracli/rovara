// Enterprise foundations, task N3: the public keys this agentx trusts to sign release bundles. PUBLIC keys only (PEM SubjectPublicKeyInfo,
// ECDSA P-256); a private key never belongs in this repository. The release pipeline's signing key is a KMS key; its public half is
// pinned here at the first signed release (the key ceremony is an owner/operations step) and published beside every bundle.
//
// Empty until then, which fails closed: with no pinned key and no `--bundle-public-key <file>` from the customer, every bundle is refused.
export const PINNED_BUNDLE_SIGNING_KEYS: readonly string[] = [];
