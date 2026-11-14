// Builds each entry for the browser with Vite, then reports minified and gzipped sizes, which packages landed in
// the bundle, and every Node built-in that any bundled module asked for.
// Writes dist/<entry>/ and dist/bundle-report.json.

import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build, type Plugin } from 'vite';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entries = ['openai', 'anthropic', 'google', 'openai-anthropic', 'all', 'lazy'];
const FORBIDDEN = ['http-proxy-agent', 'https-proxy-agent', '@smithy/node-http-handler', '@aws-sdk/client-bedrock-runtime', 'agent-base'];
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

interface EntryReport {
  files: { file: string; bytes: number; gzip: number }[];
  totalBytes: number;
  totalGzip: number;
  packages: Record<string, number>;
  forbiddenFound: string[];
  nodeImports: { source: string; importer: string }[];
  warnings: string[];
}

function packageOf(id: string): string {
  const i = id.lastIndexOf('/node_modules/');
  if (i < 0) return id.includes('/spikes/pi-ai-web/') ? '(spike adapter)' : id.includes('/packages/core/') ? '@familiar/core' : id;
  const rest = id.slice(i + '/node_modules/'.length).split('/');
  return rest[0]!.startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]!;
}

async function buildEntry(name: string): Promise<EntryReport> {
  const outDir = join(root, 'dist', name);
  const nodeImports: EntryReport['nodeImports'] = [];
  const packages: Record<string, number> = {};
  const warnings: string[] = [];
  const watch: Plugin = {
    name: 'spike-watch',
    enforce: 'pre',
    resolveId(source, importer) {
      if (builtins.has(source)) nodeImports.push({ source, importer: importer ? relative(root, importer) : '' });
      return null;
    },
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const [id, m] of Object.entries(chunk.modules)) {
          const p = packageOf(id);
          packages[p] = (packages[p] ?? 0) + m.renderedLength;
        }
      }
    }
  };
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    customLogger: {
      info() {},
      warn: (m) => warnings.push(m),
      warnOnce: (m) => warnings.push(m),
      error: (m) => warnings.push(`error: ${m}`),
      clearScreen() {},
      hasErrorLogged: () => false,
      hasWarned: false
    },
    plugins: [watch],
    build: {
      outDir,
      emptyOutDir: true,
      minify: true,
      target: 'chrome120',
      modulePreload: false,
      reportCompressedSize: false,
      rolldownOptions: {
        input: { [name]: join(root, 'src/entries', `${name}.ts`) },
        output: { entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js' },
        onwarn: (w) => warnings.push(`${w.code ?? ''} ${w.message}`)
      }
    }
  });

  const files = listJs(outDir).map((file) => {
    const buf = readFileSync(file);
    return { file: relative(outDir, file), bytes: buf.length, gzip: gzipSync(buf).length };
  });
  const text = files.map((f) => readFileSync(join(outDir, f.file), 'utf8')).join('\n');
  return {
    files,
    totalBytes: files.reduce((s, f) => s + f.bytes, 0),
    totalGzip: files.reduce((s, f) => s + f.gzip, 0),
    packages: Object.fromEntries(Object.entries(packages).sort((a, b) => b[1] - a[1])),
    forbiddenFound: FORBIDDEN.filter((p) => p in packages || text.includes(p)),
    nodeImports,
    warnings
  };
}

function listJs(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? listJs(p) : p.endsWith('.js') ? [p] : [];
  });
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KiB`;

rmSync(join(root, 'dist'), { recursive: true, force: true });
const report: Record<string, EntryReport> = {};
for (const name of entries) report[name] = await buildEntry(name);
writeFileSync(join(root, 'dist', 'bundle-report.json'), JSON.stringify(report, null, 2));

console.log('entry              minified    gzipped   files  node:* asked for   forbidden');
for (const [name, r] of Object.entries(report)) {
  const node = [...new Set(r.nodeImports.map((n) => n.source))].join(',') || '-';
  console.log(
    `${name.padEnd(18)} ${kb(r.totalBytes).padStart(10)} ${kb(r.totalGzip).padStart(10)} ${String(r.files.length).padStart(6)}  ${node.padEnd(18)} ${r.forbiddenFound.join(',') || 'none'}`
  );
}
for (const [name, r] of Object.entries(report)) {
  console.log(`\n${name}: packages by rendered size`);
  for (const [p, n] of Object.entries(r.packages)) console.log(`  ${p.padEnd(40)} ${kb(n)}`);
  if (r.files.length > 1) for (const f of r.files) console.log(`  file ${f.file.padEnd(40)} ${kb(f.bytes)} min, ${kb(f.gzip)} gz`);
  for (const n of r.nodeImports) console.log(`  node import ${n.source} from ${n.importer}`);
  for (const w of r.warnings) console.log(`  warning: ${w.split('\n')[0]}`);
}
const leaked = Object.values(report).some((r) => r.forbiddenFound.length > 0);
process.exit(leaked ? 1 : 0);
