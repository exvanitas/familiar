/* The model layer as the webview gets it: bundled for the browser the way scripts/build.ts bundles a
   page. It must hold no Node-only code (proxy agents, the AWS Bedrock client, Google's native SDK),
   no eval, and no use of the global fetch outside the SDKs' own defaults. */
import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { APP_DEFINE } from '../../scripts/define.ts';
import { nodeStub } from '../../scripts/node-stub.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const FORBIDDEN = ['http-proxy-agent', 'https-proxy-agent', '@smithy/node-http-handler', '@aws-sdk/client-bedrock-runtime', 'agent-base', '@google/genai'];

describe('the model layer bundle', async () => {
  const r = await build({
    entryPoints: { model: `${root}src/model/index.ts` },
    bundle: true, format: 'esm', target: 'chrome120', write: false, metafile: true, outdir: `${root}dist/probe`, logLevel: 'silent', define: APP_DEFINE, plugins: [nodeStub]
  });
  const out = r.outputFiles.map(f => f.text).join('\n');
  const packages = new Set(Object.keys(r.metafile.inputs).flatMap(i => {
    const m = /node_modules\/(?!.*node_modules\/)((?:@[^/]+\/)?[^/]+)/.exec(i);
    return m ? [m[1]!] : [];
  }));

  it('has pi-ai and both SDKs, and nothing Node-only', () => {
    expect([...packages]).toEqual(expect.arrayContaining(['@earendil-works/pi-ai', 'openai', '@anthropic-ai/sdk']));
    expect([...packages].filter(p => FORBIDDEN.includes(p))).toEqual([]);
  });

  it('has no eval or new Function, which the pages\' script policy refuses', () => {
    expect(out.match(/\bnew Function\(|\beval\(/g) ?? []).toEqual([]);
  });

  it("the adapter's own code never names the global fetch", async () => {
    const own = Object.keys(r.metafile.inputs).filter(i => i.includes('src/model/'));
    expect(own.length).toBeGreaterThan(3);
    const { readFileSync } = await import('node:fs');
    for (const f of own) expect(readFileSync(`${root}${f.slice(f.indexOf('src/model/'))}`, 'utf8'), f).not.toMatch(/globalThis\.fetch\(|window\.fetch|[^.\w]fetch\(/);
  });
});
