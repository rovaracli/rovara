// Service-call detector: the outside services the code calls, from the code itself. A SageMaker Runtime client and its endpoint name (boto3 or the JS SDK), and HTTP hosts named in configuration files.
// Hosts that are always local, reserved or just a namespace (localhost, example.*, w3.org) are not services.
import { type Detection, type Detector, findLine, lineOf } from "./types.js";

const SOURCE_FILE = /\.(?:py|ts|tsx|js|mjs|cjs)$/u;
const CONFIG_FILE = /(?:^|\/)(?:\.env\.example|[^/]+\.(?:ya?ml|toml|ini|cfg|json|properties))$/u;
const SKIP_DIRS = /(?:^|\/)(?:node_modules|dist|build|\.git|venv|\.venv|vendor|tests?|__tests__|fixtures?)\//u;
const IGNORED_HOSTS = /^(?:localhost|127\.|0\.0\.0\.0|.*\.example\.(?:com|org|net)|example\.(?:com|org|net)|.*\.test|.*\.invalid|.*\.local|www\.w3\.org|json-schema\.org|schemas\.[a-z.]+|xmlns\.com|purl\.org|opensource\.org|github\.com|raw\.githubusercontent\.com|pypi\.org|files\.pythonhosted\.org|registry\.npmjs\.org|npmjs\.org)$/u;
const MAX_FILES = 150;
const MAX_HTTP = 20;
const ENDPOINT = /EndpointName\s*[=:]\s*["']([A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))["']/u;

export const detectServices: Detector = async ({ repo }) => {
  const services: Detection["services"] = [];
  const questions: string[] = [];
  const seen = new Set<string>();
  const add = (kind: "sagemaker_runtime" | "http", target: string, source: { path: string; line: number }) => {
    const key = `${kind}:${target}`;
    if (seen.has(key) || (kind === "http" && services.filter((service) => service.value.kind === "http").length >= MAX_HTTP)) return;
    seen.add(key);
    services.push({ value: { kind, target }, source });
  };
  const files = repo.paths.filter((path) => !SKIP_DIRS.test(path));
  for (const path of files.filter((candidate) => SOURCE_FILE.test(candidate)).slice(0, MAX_FILES)) {
    const text = await repo.read(path);
    if (text === undefined || !/sagemaker[-_ ]?runtime|SageMakerRuntime|invoke_endpoint|InvokeEndpoint/iu.test(text)) continue;
    const endpoint = ENDPOINT.exec(text);
    const callLine = findLine(text, /sagemaker[-_ ]?runtime|SageMakerRuntime|invoke_endpoint|InvokeEndpoint/iu) ?? 1;
    if (endpoint?.[1] !== undefined) add("sagemaker_runtime", endpoint[1], { path, line: lineOf(text, endpoint.index) });
    else questions.push(`Which SageMaker endpoint does ${path} call? Its name is not written in the code, so it cannot be mocked until a maintainer names it (call at line ${String(callLine)}).`);
  }
  for (const path of files.filter((candidate) => CONFIG_FILE.test(candidate)).slice(0, MAX_FILES)) {
    const text = await repo.read(path);
    if (text === undefined) continue;
    for (const match of text.matchAll(/https?:\/\/([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::\d{1,5})?(?=[/"'\s,;)]|$)/gu)) {
      const host = match[1]!.toLowerCase();
      if (!host.includes(".") || IGNORED_HOSTS.test(host)) continue;
      add("http", host, { path, line: lineOf(text, match.index) });
    }
  }
  return services.length === 0 && questions.length === 0 ? {} : { services, questions };
};
