import { BROKER_NAMES, BROKER_NAMES_VARIABLE, BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE, type BrokerNameKey, type BrokerSettingKey } from "@agentx/cloud-contracts";

/**
 * The broker's one variable of names (AGENTX_NAMES, packages/contracts/src/broker-names.ts), read out of a synthesized template. The control
 * plane joins it from the resources' own names, so a test reads it as a map from a name's key (`signInTable`) to the template node that
 * resolves to that name: `{ Ref: "<logical id>" }` or `{ "Fn::GetAtt": ["<logical id>", "<attribute>"] }`.
 */
type Node = unknown;
type Variables = Record<string, Node>;

const MARK = /‹(\d+)›/;
const KEY_OF_CODE = new Map<string, BrokerNameKey>(Object.entries(BROKER_NAMES).map(([key, spec]) => [spec.code, key as BrokerNameKey]));

/** Fn::Join of a JSON text with the nodes between its literal pieces, as the text with `‹n›` where node n goes, and the nodes. */
function joinedText(variable: Node): { text: string; nodes: Node[] } {
  const join = (variable as { "Fn::Join"?: [string, Node[]] } | undefined)?.["Fn::Join"];
  if (join === undefined || join[0] !== "") throw new Error(`${BROKER_NAMES_VARIABLE} is not a Fn::Join with no delimiter: ${JSON.stringify(variable)}`);
  const nodes: Node[] = [];
  const text = join[1].map((part) => (typeof part === "string" ? part : `‹${nodes.push(part) - 1}›`)).join("");
  return { text, nodes };
}

/** `code=value,code=value` as pairs (the form the control plane writes; a node stands as its `‹n›` mark). */
function pairsOf(text: string): Array<[string, string]> {
  return text === "" ? [] : text.split(",").map((pair) => {
    const at = pair.indexOf("=");
    if (at !== 2) throw new Error(`not a code=value pair: ${pair}`);
    return [pair.slice(0, 2), pair.slice(3)];
  });
}

/** The names the variable holds, by key. A name is a template node, or the literal text where the control plane wrote one. */
export function brokerNamesIn(variables: Variables | undefined): Partial<Record<BrokerNameKey, Node>> {
  const variable = variables?.[BROKER_NAMES_VARIABLE];
  if (variable === undefined) return {};
  const { text, nodes } = joinedText(variable);
  return Object.fromEntries(pairsOf(text).map(([code, value]) => {
    const key = KEY_OF_CODE.get(code);
    if (key === undefined) throw new Error(`${BROKER_NAMES_VARIABLE} holds a code nobody sent: ${code}`);
    const marked = MARK.exec(value);
    return [key, marked === null ? value : nodes[Number(marked[1])]];
  }));
}

const SETTING_KEY_OF_CODE = new Map<string, BrokerSettingKey>(Object.entries(BROKER_SETTINGS).map(([key, spec]) => [spec.code, key as BrokerSettingKey]));

/** The broker's settings (AGENTX_SETTINGS, the same shape as its names), by key: the template node that resolves to the setting's value, or the literal text. */
export function brokerSettingsIn(variables: Variables | undefined): Partial<Record<BrokerSettingKey, Node>> {
  const variable = variables?.[BROKER_SETTINGS_VARIABLE];
  if (variable === undefined) return {};
  const { text, nodes } = joinedText(variable);
  return Object.fromEntries(pairsOf(text).map(([code, value]) => {
    const key = SETTING_KEY_OF_CODE.get(code);
    if (key === undefined) throw new Error(`${BROKER_SETTINGS_VARIABLE} holds a code nobody sent: ${code}`);
    const marked = MARK.exec(value);
    return [key, marked === null ? value : nodes[Number(marked[1])]];
  }));
}

/** `code=node` pairs written back as a template node (the order is the code order, as the control plane writes it; adjacent literals are one piece). */
function joinedPairs(entries: Array<[string, Node]>): Node {
  const pieces: Node[] = [];
  entries.sort(([a], [b]) => a.localeCompare(b)).forEach(([code, node], index) => { pieces.push(`${index === 0 ? "" : ","}${code}=`, node); });
  const merged: Node[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (typeof piece === "string" && typeof last === "string") merged[merged.length - 1] = last + piece;
    else merged.push(piece);
  }
  return { "Fn::Join": ["", merged] };
}

/**
 * Takes the names `keys` out of the broker's variable, in place, and gives them back (a variable left with no name is removed). For the
 * `withoutX` helpers, which take one feature's additions out of a template so that the rest still matches the recorded snapshot.
 */
export function takeBrokerNames(variables: Variables, keys: readonly BrokerNameKey[]): Partial<Record<BrokerNameKey, Node>> {
  const all = brokerNamesIn(variables);
  const taken: Partial<Record<BrokerNameKey, Node>> = {};
  for (const key of keys) {
    if (!(key in all)) throw new Error(`the broker's names hold no ${key}`);
    taken[key] = all[key];
    delete all[key];
  }
  if (Object.keys(all).length === 0) delete variables[BROKER_NAMES_VARIABLE];
  else variables[BROKER_NAMES_VARIABLE] = joinedPairs(Object.entries(all).map(([key, node]) => [BROKER_NAMES[key as BrokerNameKey].code, node]));
  return taken;
}

/** The same for the broker's settings (AGENTX_SETTINGS). */
export function takeBrokerSettings(variables: Variables, keys: readonly BrokerSettingKey[]): Partial<Record<BrokerSettingKey, Node>> {
  const all = brokerSettingsIn(variables);
  const taken: Partial<Record<BrokerSettingKey, Node>> = {};
  for (const key of keys) {
    if (!(key in all)) throw new Error(`the broker's settings hold no ${key}`);
    taken[key] = all[key];
    delete all[key];
  }
  if (Object.keys(all).length === 0) delete variables[BROKER_SETTINGS_VARIABLE];
  else variables[BROKER_SETTINGS_VARIABLE] = joinedPairs(Object.entries(all).map(([key, node]) => [BROKER_SETTINGS[key as BrokerSettingKey].code, node]));
  return taken;
}
