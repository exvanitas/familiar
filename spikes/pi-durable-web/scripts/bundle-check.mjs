// Bundles pi-durable's entry points, and the engine path Familiar would use, with Vite for the browser, with no
// Node polyfills. Node built-ins are left external and recorded with the chain of imports that reached them.
// Sizes are minified, then gzipped with zlib level 9.

import { builtinModules } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';

const here = join(import.meta.dirname, '..');
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

const ENTRIES = {
  'pi-durable (root)': `export * from '@earendil-works/pi-durable';`,
  'pi-durable/storage/indexeddb': `export * from '@earendil-works/pi-durable/storage/indexeddb';`,
  'pi-durable/storage/sqlite': `export * from '@earendil-works/pi-durable/storage/sqlite';`,
  'pi-durable/storage/memory': `export * from '@earendil-works/pi-durable/storage/memory';`,
  'pi-durable/storage/jsonl': `export * from '@earendil-works/pi-durable/storage/jsonl';`,
  'pi-durable/storage/store': `export * from '@earendil-works/pi-durable/storage/store';`,
  'pi-durable/testing': `export * from '@earendil-works/pi-durable/testing';`,
  'pi-durable/env': `export * from '@earendil-works/pi-durable/env';`,
  'pi-durable/tools': `export * from '@earendil-works/pi-durable/tools';`,
  'pi-durable/images': `export * from '@earendil-works/pi-durable/images';`,
  'pi-durable/codemode': `export * from '@earendil-works/pi-durable/codemode';`,
  'pi-durable/tool-search': `export * from '@earendil-works/pi-durable/tool-search';`,
  'pi-durable/env/node': `export * from '@earendil-works/pi-durable/env/node';`,
  'pi-durable/storage/sqlite/node': `export * from '@earendil-works/pi-durable/storage/sqlite/node';`,
  'pi-ai/models': `export * from '@earendil-works/pi-ai/models';`,
  'pi-ai (root)': `export * from '@earendil-works/pi-ai';`,
  // What Familiar would ship: the engine module (Harness, registry, tools, hooks, reminder task, port adapter).
  'familiar engine + IndexedDB': `export * from '../src/engine.ts'; export { IndexedDbStorage } from '@earendil-works/pi-durable/storage/indexeddb';`,
  'familiar engine + SQLite core': `export * from '../src/engine.ts'; export { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';`,
  'familiar engine + both': `export * from '../src/engine.ts'; export { IndexedDbStorage } from '@earendil-works/pi-durable/storage/indexeddb'; export { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';`
};

const HEAVY = {
  photon: /@silvia-odwyer\/photon/,
  'pi-codemode (QuickJS)': /pi-codemode|quickjs/i,
  diff: /node_modules\/diff\//,
  'pi-ai providers': /pi-ai\/dist\/(providers|api)\//,
  'provider SDKs': /@anthropic-ai|openai@|\/openai\/|@google\/genai|@aws-sdk|@smithy/,
  'pi-durable tools/env/images': /pi-durable\/dist\/(tools|env|images|codemode)\//
};

function packageOf(id) {
  const short = shortId(id);
  if (short !== relative(here, id)) {
    const m = short.match(/^((?:@[^/]+\/)?[^/]+)\//);
    if (m) return m[1];
  }
  return id.startsWith(here) ? `(spike) ${relative(here, id)}` : id;
}

async function bundle(name, source, minify) {
  const nodeImports = [];
  const slug = name.replace(/[^a-z0-9]+/gi, '-');
  const entryDir = join(here, '.entries');
  mkdirSync(entryDir, { recursive: true });
  const entryFile = join(entryDir, `${slug}.js`);
  writeFileSync(entryFile, source);
  const virtualId = entryFile;
  let output;
  const warnings = [];
  const result = await build({
    root: here,
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify,
      target: 'es2022',
      reportCompressedSize: false,
      lib: { entry: entryFile, formats: ['es'], fileName: 'out' },
      rollupOptions: {
        onwarn(w) {
          warnings.push(w.message ?? String(w));
        }
      }
    },
    resolve: { conditions: ['browser', 'import', 'default'] },
    plugins: [
      {
        name: 'spike-entry',
        enforce: 'pre',
        resolveId(id, importer) {
          if (BUILTINS.has(id) || id.startsWith('node:')) {
            nodeImports.push({ id, importer });
            return { id, external: true };
          }
          return null;
        },
        generateBundle() {
          // Walk each Node import back to the entry, so the report says how it got pulled in.
          for (const record of nodeImports) {
            const chain = [];
            let at = record.importer;
            const seen = new Set();
            while (at && !seen.has(at) && at !== virtualId) {
              seen.add(at);
              chain.push(packageOf(at).startsWith('@') || packageOf(at).startsWith('(') ? shortId(at) : shortId(at));
              const info = this.getModuleInfo(at);
              at = info?.importers?.[0];
            }
            record.chain = chain;
          }
        }
      }
    ]
  });
  output = (Array.isArray(result) ? result[0] : result).output;
  const chunks = output.filter((o) => o.type === 'chunk');
  const assets = output.filter((o) => o.type === 'asset');
  const code = chunks.map((c) => c.code).join('\n');
  const byPackage = {};
  for (const chunk of chunks) {
    for (const [id, info] of Object.entries(chunk.modules ?? {})) {
      const pkg = packageOf(id);
      byPackage[pkg] = (byPackage[pkg] ?? 0) + (info.renderedLength ?? 0);
    }
  }
  const moduleIds = chunks.flatMap((c) => Object.keys(c.modules ?? {}));
  // Match on the path inside the package, not pnpm's folder name (which can name unrelated peers).
  const heavy = Object.fromEntries(Object.entries(HEAVY).map(([k, re]) => [k, moduleIds.map(shortId).filter((id) => re.test('node_modules/' + id)).length]));
  const heavyIds = moduleIds.map(shortId).filter((id) => Object.values(HEAVY).some((re) => re.test('node_modules/' + id)));
  return {
    name,
    bytes: Buffer.byteLength(code),
    gzip: gzipSync(code, { level: 9 }).length,
    chunks: chunks.length,
    assets: assets.map((a) => ({ name: a.fileName, bytes: a.source.length })),
    modules: moduleIds.length,
    nodeImports: dedupe(nodeImports),
    globals: {
      process: (code.match(/\bprocess\.(env|cwd|platform|versions|nextTick|on|exit)\b/g) ?? []).length,
      Buffer: (code.match(/\bBuffer\.(from|alloc|byteLength|concat|isBuffer)\b/g) ?? []).length,
      require: (code.match(/\brequire\(/g) ?? []).length
    },
    heavy,
    heavyIds: heavyIds.slice(0, 20),
    byPackage: Object.fromEntries(Object.entries(byPackage).sort((a, b) => b[1] - a[1]).slice(0, 14)),
    warnings: warnings.slice(0, 5)
  };
}

function shortId(id) {
  const i = id.lastIndexOf('node_modules/');
  return i >= 0 ? id.slice(i + 'node_modules/'.length) : relative(here, id);
}
function dedupe(records) {
  const map = new Map();
  for (const r of records) {
    const k = `${r.id} <- ${r.chain?.[0]}`;
    if (!map.has(k)) map.set(k, { id: r.id, chain: r.chain });
  }
  return [...map.values()];
}

const rows = [];
for (const [name, source] of Object.entries(ENTRIES)) {
  try {
    const min = await bundle(name, source, true);
    rows.push(min);
  } catch (error) {
    rows.push({ name, failed: String(error?.message ?? error).split('\n').slice(0, 4).join(' | ') });
  }
}

mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'bundle.json'), JSON.stringify(rows, null, 2));
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
console.log('entry | min | gzip | node built-ins | photon/codemode/diff/providers');
for (const r of rows) {
  if (r.failed) {
    console.log(`${r.name} | FAILED: ${r.failed}`);
    continue;
  }
  const node = [...new Set(r.nodeImports.map((n) => n.id))].join(', ') || 'none';
  const heavy = Object.entries(r.heavy).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(' ') || 'none';
  console.log(`${r.name} | ${kb(r.bytes)} | ${kb(r.gzip)} | ${node} | ${heavy}${r.assets.length ? ' | assets ' + r.assets.map((a) => `${a.name} ${kb(a.bytes)}`).join(', ') : ''}`);
}
