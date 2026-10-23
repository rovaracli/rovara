import { Fn, Lazy } from "aws-cdk-lib";
import type { aws_lambda as lambda } from "aws-cdk-lib";
import { BROKER_NAMES, BROKER_NAMES_VARIABLE, type BrokerNameKey } from "@agentx/contracts";

/**
 * The names the broker is given in one variable (final review C1). Lambda holds all of a function's environment variables, keys and values
 * together, to 4 KB, and every name CloudFormation generates for a resource is `<stack>-<LogicalId>-<random>`, 60 to 90 characters; the
 * broker's variables passed the limit and the first staging deploy would have failed. So each construct adds the names it owns here, as the
 * bare name or id (a queue's name, not its URL; a key's id, not its ARN), and the broker's one variable, AGENTX_NAMES, is a JSON object of
 * them under two-letter codes (`BROKER_NAMES` in @agentx/contracts says which code is which variable and what the broker builds from it).
 * The broker puts each back under the variable its code reads (packages/broker/src/aws/broker-environment.ts).
 *
 * A name is a CloudFormation Ref or attribute, so it is resolved at deploy time; the JSON is joined from the pieces, in code order, and is
 * not built until synthesis, after every construct has added its own. Named environments only: the legacy install passes its variables whole.
 */
export class BrokerNames {
  private static readonly byBroker = new WeakMap<lambda.Function, BrokerNames>();
  private readonly names = new Map<BrokerNameKey, string>();

  private constructor(broker: lambda.Function) {
    broker.addEnvironment(BROKER_NAMES_VARIABLE, Lazy.string({ produce: () => this.json() }));
  }

  /** The broker's names; the first call gives it the variable. */
  static of(broker: lambda.Function): BrokerNames {
    const existing = BrokerNames.byBroker.get(broker);
    if (existing !== undefined) return existing;
    const created = new BrokerNames(broker);
    BrokerNames.byBroker.set(broker, created);
    return created;
  }

  /** A resource's name or id, which must be the bare name (a token that resolves to one). */
  add(key: BrokerNameKey, value: string): void {
    if (this.names.has(key)) throw new Error(`the broker's name ${key} is added twice`);
    this.names.set(key, value);
  }

  private json(): string {
    const parts = [...this.names.entries()]
      .sort(([a], [b]) => BROKER_NAMES[a].code.localeCompare(BROKER_NAMES[b].code))
      .flatMap(([key, value], index) => [`${index === 0 ? "" : ","}"${BROKER_NAMES[key].code}":"`, value, '"']);
    return Fn.join("", ["{", ...parts, "}"]);
  }
}
