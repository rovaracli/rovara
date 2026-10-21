// An in-memory KMS for the audit ledger's details vault: GenerateDataKey and Decrypt for one symmetric key, with the
// vault key policy's conditions enforced (infra/lib/audit-ledger.ts, AppenderUse and BrokerUse), and KMS's own rule that
// Decrypt works only with the encryption context the data key was made with. The fake does not model anything else.
import { randomBytes } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from "@aws-sdk/client-kms";

/** Who is calling: the roles the key policy names, or anyone else. */
export type FakeKmsCaller = "appender" | "broker" | "other";

export interface FakeKmsCall {
  operation: "GenerateDataKey" | "Decrypt";
  caller: FakeKmsCaller;
  keyId: string | undefined;
  context: Record<string, string>;
  /** Whether the call was refused (by the key policy, the context or the key id). */
  refused: boolean;
}

interface Shared {
  readonly blobs: Map<string, { context: Record<string, string>; plaintext: Buffer }>;
  readonly calls: FakeKmsCall[];
}

/** What the vault key policy allows each caller: AppenderUse is both actions, BrokerUse Decrypt only, anyone else nothing. */
const ALLOWED: Record<FakeKmsCaller, readonly string[]> = {
  appender: ["GenerateDataKey", "Decrypt"],
  broker: ["Decrypt"],
  other: [],
};

const BLOB_PREFIX = "fake-kms-blob:";

function refusal(name: string, message: string): Error {
  return Object.assign(new Error(message), { name, $metadata: {} });
}

export class FakeKms {
  private readonly shared: Shared;

  /** `keyArn` is the only key id the fake accepts: an alias can be repointed, so the code must name the key by ARN. */
  constructor(readonly keyArn: string, readonly caller: FakeKmsCaller = "appender", shared?: Shared) {
    this.shared = shared ?? { blobs: new Map(), calls: [] };
  }

  /** The same key and the same ciphertexts, called as another principal. */
  as(caller: FakeKmsCaller): FakeKms {
    return new FakeKms(this.keyArn, caller, this.shared);
  }

  get calls(): readonly FakeKmsCall[] {
    return this.shared.calls;
  }

  readonly client = { send: (command: unknown) => this.send(command) } as unknown as KMSClient;

  private async send(command: unknown): Promise<unknown> {
    await Promise.resolve();
    if (command instanceof GenerateDataKeyCommand) {
      const { KeyId, KeySpec, EncryptionContext } = command.input;
      const context = { ...(EncryptionContext ?? {}) };
      const call = this.check("GenerateDataKey", KeyId, context);
      if (KeySpec !== "AES_256") throw this.refuse(call, refusal("ValidationException", "the fake issues AES_256 data keys only"));
      const plaintext = randomBytes(32);
      const id = randomBytes(24).toString("hex");
      this.shared.blobs.set(id, { context, plaintext });
      return { KeyId: this.keyArn, Plaintext: Uint8Array.from(plaintext), CiphertextBlob: Uint8Array.from(Buffer.from(BLOB_PREFIX + id)) };
    }
    if (command instanceof DecryptCommand) {
      const { KeyId, CiphertextBlob, EncryptionContext } = command.input;
      const context = { ...(EncryptionContext ?? {}) };
      const call = this.check("Decrypt", KeyId, context);
      const text = Buffer.from(CiphertextBlob ?? new Uint8Array()).toString();
      const stored = text.startsWith(BLOB_PREFIX) ? this.shared.blobs.get(text.slice(BLOB_PREFIX.length)) : undefined;
      if (stored === undefined) throw this.refuse(call, refusal("InvalidCiphertextException", "not a ciphertext of this key"));
      const keys = Object.keys(stored.context);
      // KMS decrypts only with exactly the context the data key was made with.
      if (keys.length !== Object.keys(context).length || keys.some((key) => context[key] !== stored.context[key])) {
        throw this.refuse(call, refusal("InvalidCiphertextException", "the encryption context does not match"));
      }
      return { KeyId: this.keyArn, Plaintext: Uint8Array.from(stored.plaintext) };
    }
    throw new Error("FakeKms only supports GenerateDataKey and Decrypt");
  }

  private refuse(call: FakeKmsCall, error: Error): Error {
    call.refused = true;
    return error;
  }

  /** The key policy and the key id, as KMS evaluates them before it does any work. */
  private check(operation: FakeKmsCall["operation"], keyId: string | undefined, context: Record<string, string>): FakeKmsCall {
    const call: FakeKmsCall = { operation, caller: this.caller, keyId, context, refused: false };
    this.shared.calls.push(call);
    const fail = (error: Error): never => {
      throw this.refuse(call, error);
    };
    if (!ALLOWED[this.caller].includes(operation)) fail(refusal("AccessDeniedException", `the key policy does not allow ${this.caller} to ${operation}`));
    // AppenderUse and BrokerUse: StringEquals kms:EncryptionContext:rovara:purpose = audit-details, and
    // ForAnyValue:StringEquals kms:EncryptionContextKeys = ["rovara:org"].
    if (context["rovara:purpose"] !== "audit-details") fail(refusal("AccessDeniedException", "the key policy requires the encryption context rovara:purpose = audit-details"));
    if (!Object.hasOwn(context, "rovara:org")) fail(refusal("AccessDeniedException", "the key policy requires the encryption context key rovara:org"));
    if (keyId !== this.keyArn) fail(refusal("NotFoundException", "the fake accepts the key's ARN only, never an alias or a bare id"));
    return call;
  }
}
