import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { App, Stack, aws_apigatewayv2 as apigwv2, aws_s3_assets as assets } from "aws-cdk-lib";
import { expect, it } from "vitest";
import { WebApp } from "../../infra/lib/web-app.js";
import { environmentNaming } from "../../infra/lib/naming.js";
it("bundles the real shell and compressed files beside an executable, filesystem-only handler", () => {
 expect(existsSync("node_modules/.bin/esbuild")).toBe(true);
 const directory = mkdtempSync(join(tmpdir(), "rovara-web-bundle-"));
 try {
  const app = new App({ outdir: directory, context: { "aws:cdk:bundling-stacks": ["*"] } });
  const stack = new Stack(app, "WebBundleFixture", { env: { account: "123456789012", region: "us-west-2" } });
  const api = new apigwv2.CfnApi(stack, "Api", { protocolType: "HTTP" });
  const web = new WebApp(stack, "Web", { naming: environmentNaming("staging"), api, assetHosting: "cell" });
  const code = web.handlerFunction.node.findAll().find((child): child is assets.Asset => child instanceof assets.Asset);
  expect(code).toBeDefined();const assetDirectory = resolve(directory, code!.assetPath);expect(existsSync(join(assetDirectory, "app/index.html"))).toBe(true);
  const script = `const fs=require('node:fs'),zlib=require('node:zlib'),assert=require('node:assert/strict'),root=process.env.LAMBDA_TASK_ROOT;const{handler}=require(root+'/index.js');(async()=>{const shell=await handler({rawPath:'/app',requestContext:{http:{method:'GET'}}});assert.equal(shell.statusCode,200);assert(shell.body.includes('/app/assets/'));assert(shell.body.includes('csp-nonce'));assert.equal(shell.headers['cross-origin-opener-policy'],'same-origin-allow-popups');const file=fs.readdirSync(root+'/app/assets').find(name=>name.endsWith('.js'));assert(file);const response=await handler({rawPath:'/app/assets/'+file,headers:{'accept-encoding':'br'},requestContext:{http:{method:'GET'}}});assert.equal(response.statusCode,200);assert.equal(response.headers['content-encoding'],'br');assert.equal(response.isBase64Encoded,true);assert.deepEqual(zlib.brotliDecompressSync(Buffer.from(response.body,'base64')),fs.readFileSync(root+'/app/assets/'+file));console.log('shell and Brotli asset verified');})().catch(()=>{console.error('bundled handler verification failed');process.exitCode=1;});`;
  const child = spawnSync(process.execPath, ["-e", script], { env: { LAMBDA_TASK_ROOT: assetDirectory }, encoding: "utf8", timeout: 20_000 });
  expect(child.status, child.stderr).toBe(0);expect(child.stdout.trim()).toBe("shell and Brotli asset verified");
 } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120_000);
