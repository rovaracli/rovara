import { ROVARA_GUARD_SHA256 } from "./rovara-guard-packed.js";

/** The environment variable that carries the packed guard (zlib-deflated, base64) into the proxy's container; the container writes it to /tmp/rovara_guard.py at start. */
export const ROVARA_GUARD_ENV = "ROVARA_GUARD_Z";

/**
 * What the proxy's container runs (`sh -c`): write the generated config; unpack the guard to a file beside it (LiteLLM loads a callback module from the config's directory); stop with a message
 * unless the unpacked bytes hash to the pinned SHA-256 (nothing is started with a guard that is not the verified one); then replace the shell with LiteLLM so it receives the stop signal.
 * The Python is in the image already (it is LiteLLM's), runs isolated (-I: nothing in the working directory can stand in for zlib, base64 or hashlib), is one line without a single quote so the shell passes it through unchanged, and reads the packed guard from the environment.
 */
export function litellmStartCommand(port: number): string {
  const unpack = [
    "import base64,hashlib,os,sys,zlib",
    `d=zlib.decompress(base64.b64decode(os.environ["${ROVARA_GUARD_ENV}"]))`,
    `hashlib.sha256(d).hexdigest()=="${ROVARA_GUARD_SHA256}" or sys.exit("rovara_guard.py does not match its pinned SHA-256")`,
    `open("/tmp/rovara_guard.py","wb").write(d)`,
  ].join(";");
  return `printf "%s" "$LITELLM_CONFIG_YAML" > /tmp/litellm.yaml && python -I -c '${unpack}' && exec litellm --config /tmp/litellm.yaml --port ${String(port)}`;
}
