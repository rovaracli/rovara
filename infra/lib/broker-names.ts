import { CfnParameter, Fn, Lazy, Stack, Token } from "aws-cdk-lib";
import type { aws_lambda as lambda } from "aws-cdk-lib";
import { BROKER_NAMES, BROKER_NAMES_VARIABLE, BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE, BROKER_SETTING_VALUE, type BrokerNameKey, type BrokerSettingKey } from "@agentx/cloud-contracts";

/** A literal name: what the broker accepts as a name (broker-environment.ts), so a literal with a separator is refused when it is added. */
const LITERAL_NAME = /^[A-Za-z0-9._-]{1,255}$/;
/** What must never reach the JSON joined without escaping: it ends a pair, starts a value, or escapes (the pairs are `code=value,code=value`). */
const SEPARATORS = ['"', "\\", ",", "=", "{", "}", "/", " ", "\n"];

/** True where the pattern has a construct that takes any character (`.`, `\S`, `\W`, `\D`, a negated class), outside a character class where `.` is literal. */
function patternIsOpen(pattern: string): boolean {
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "\\") {
      if ("SWD".includes(pattern[index + 1] ?? "")) return true;
      index++;
    } else if (inClass) {
      if (char === "]") inClass = false;
    } else if (char === "[") {
      inClass = true;
      if (pattern[index + 1] === "^") return true;
    } else if (char === ".") return true;
  }
  return false;
}

/** Whether an AllowedPattern lets a separator through: no open construct, and no probe built from the pattern's own leading literal plus a separator matches. A guard, not a proof. */
function patternAdmitsSeparator(pattern: string): boolean {
  if (patternIsOpen(pattern)) return true;
  let accepts: RegExp;
  try { accepts = new RegExp(pattern); } catch { return true; }
  const prefix = /^\^?((?:[A-Za-z0-9_:-]|\\\.)*)/.exec(pattern)?.[1]?.replace(/\\\./g, ".") ?? "";
  const bases = ["", "a", "0", "T0", "E0", prefix, `${prefix}0`, `${prefix}a`];
  return bases.some((base) => SEPARATORS.some((separator) => [`${base}${separator}`, `${base}${separator}0`, `${base}0${separator}0`, `${base}a${separator}b`].some((probe) => accepts.test(probe))));
}

/**
 * Packing needs a value that cannot carry a separator. A literal is checked at once (by the caller). A token is checked when the variable is built, at synthesis: every Ref to a
 * parameter in it must be a Number, or have AllowedValues without a separator, or an AllowedPattern that admits none. Other tokens (a resource's name, an attribute, a Select of
 * a Split) are CloudFormation's own generated values.
 */
function refuseUnconstrainedParameters(scope: Stack, what: string, key: string, value: string): void {
  const parameters = new Map<string, CfnParameter>();
  for (const child of scope.node.findAll()) if (child instanceof CfnParameter) parameters.set(String(scope.resolve(child.logicalId)), child);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const ref = record.Ref;
    const parameter = typeof ref === "string" ? parameters.get(ref) : undefined;
    if (parameter !== undefined) {
      if (parameter.type === "Number") return;
      const unsafe = (reason: string): never => { throw new Error(`${what} ${key} comes from the parameter ${String(ref)}, which ${reason}; it is joined into the broker's variable unescaped, so the parameter needs an AllowedPattern or AllowedValues that keeps out quotes, commas, equals signs, braces, slashes and spaces`); };
      if (parameter.allowedValues !== undefined) {
        if (parameter.allowedValues.some((allowed) => SEPARATORS.some((separator) => allowed.includes(separator)))) unsafe("allows a value with a separator");
      } else if (parameter.allowedPattern === undefined) unsafe("has no AllowedPattern or AllowedValues");
      else if (patternAdmitsSeparator(parameter.allowedPattern)) unsafe(`has an AllowedPattern (${parameter.allowedPattern}) that admits a separator`);
      return;
    }
    Object.values(record).forEach(walk);
  };
  walk(scope.resolve(value));
}

/**
 * The names the broker is given in one variable (final review C1). Lambda holds all of a function's environment variables, keys and values
 * together, to 4 KB, and every name CloudFormation generates for a resource is `<stack>-<LogicalId>-<random>`, 60 to 90 characters; the
 * broker's variables passed the limit and the first staging deploy would have failed. So each construct adds the names it owns here, as the
 * bare name or id (a queue's name, not its URL; a key's id, not its ARN), and the broker's one variable, AGENTX_NAMES, is a list of `code=value` pairs
 * them under two-letter codes (`BROKER_NAMES` in @agentx/contracts says which code is which variable and what the broker builds from it).
 * The broker puts each back under the variable its code reads (packages/broker/src/aws/broker-environment.ts).
 *
 * A name is a CloudFormation Ref or attribute, so it is resolved at deploy time; the list is joined from the pieces, in code order, and is
 * not built until synthesis, after every construct has added its own. Named environments only: the legacy install passes its variables whole.
 */
export class BrokerNames {
  private static readonly byBroker = new WeakMap<lambda.Function, BrokerNames>();
  private readonly names = new Map<BrokerNameKey, string>();
  private readonly stack: Stack;

  private constructor(broker: lambda.Function) {
    this.stack = Stack.of(broker);
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
    if (!Token.isUnresolved(value) && !LITERAL_NAME.test(value)) throw new Error(`the broker's name ${key} is a literal that is not a plain name (letters, digits, . _ -), and it is joined into the broker's variable unescaped`);
    this.names.set(key, value);
  }

  private json(): string {
    for (const [key, value] of this.names) refuseUnconstrainedParameters(this.stack, "the broker's name", key, value);
    const parts = [...this.names.entries()]
      .sort(([a], [b]) => BROKER_NAMES[a].code.localeCompare(BROKER_NAMES[b].code))
      .flatMap(([key, value], index) => [`${index === 0 ? "" : ","}${BROKER_NAMES[key].code}=`, value]);
    return Fn.join("", parts);
  }
}

/**
 * The broker's settings in one variable, AGENTX_SETTINGS (ENV-ROOM; `BROKER_SETTINGS` in @agentx/contracts says which code is which variable). Built the way BrokerNames builds
 * its list: joined from the pieces, in code order, at synthesis. A setting is a CloudFormation parameter whose value is already constrained to plain text (an enum, a
 * number, a Slack team id), so nothing needs escaping; the broker refuses any value that is not plain (`BROKER_SETTING_VALUE`) and does not start. A parameter with no such
 * constraint does not belong here. Named environments only: the legacy install passes its variables whole.
 */
export class BrokerSettings {
  private static readonly byBroker = new WeakMap<lambda.Function, BrokerSettings>();
  private readonly values = new Map<BrokerSettingKey, string>();
  private readonly stack: Stack;

  private constructor(broker: lambda.Function) {
    this.stack = Stack.of(broker);
    broker.addEnvironment(BROKER_SETTINGS_VARIABLE, Lazy.string({ produce: () => this.json() }));
  }

  /** The broker's settings; the first call gives it the variable. */
  static of(broker: lambda.Function): BrokerSettings {
    const existing = BrokerSettings.byBroker.get(broker);
    if (existing !== undefined) return existing;
    const created = new BrokerSettings(broker);
    BrokerSettings.byBroker.set(broker, created);
    return created;
  }

  /** A setting's value, which must be plain text (a parameter with an allowed list or pattern, or a literal). */
  add(key: BrokerSettingKey, value: string): void {
    if (this.values.has(key)) throw new Error(`the broker's setting ${key} is added twice`);
    if (!Token.isUnresolved(value) && !BROKER_SETTING_VALUE.test(value)) throw new Error(`the broker's setting ${key} is a literal that is not plain text, and it is joined into the broker's variable unescaped`);
    this.values.set(key, value);
  }

  private json(): string {
    for (const [key, value] of this.values) refuseUnconstrainedParameters(this.stack, "the broker's setting", key, value);
    const parts = [...this.values.entries()]
      .sort(([a], [b]) => BROKER_SETTINGS[a].code.localeCompare(BROKER_SETTINGS[b].code))
      .flatMap(([key, value], index) => [`${index === 0 ? "" : ","}${BROKER_SETTINGS[key].code}=`, value]);
    return Fn.join("", parts);
  }
}
