// Lane A3: Cloud's model key store (install keys in Secrets Manager, by ARN) under Code's model-key-store suite, over an in-memory Secrets Manager (no AWS).
import { createCloudModelKeyStore } from "../../../packages/broker/src/cloud-adapters/model-keys/secrets-manager.js";
import { FakeModelKeySecrets } from "../../support/fake-model-key-secrets.js";
import { defineCloudAdapter } from "../registry.js";

export const secretsManagerModelKeyStore = defineCloudAdapter({
  port: "model-key-store",
  name: "Secrets Manager install keys",
  harness: {
    async create(keys) {
      const secrets = new FakeModelKeySecrets();
      return createCloudModelKeyStore({ secrets, installKeys: secrets.hold(keys) });
    },
  },
});

export const cachedSecretsManagerModelKeyStore = defineCloudAdapter({
  port: "model-key-store",
  name: "Secrets Manager install keys (cached 60 s)",
  harness: {
    async create(keys) {
      const secrets = new FakeModelKeySecrets();
      return createCloudModelKeyStore({ secrets, installKeys: secrets.hold(keys), cacheMs: 60_000 });
    },
  },
});
