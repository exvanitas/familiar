// Runs regex keys in a worker thread, so the test can stop it if one ever hangs. Each case: compile the
// key, then test it on its text, and report whether it matched and how long it took.
import { parentPort, workerData } from 'node:worker_threads';
import { compileKey } from '../src/regex.ts';

interface Case {
  readonly key: string;
  readonly text: string;
}

const out = (workerData as Case[]).map(({ key, text }) => {
  const started = performance.now();
  const c = compileKey(key, true);
  const matched = c.ok ? c.regex.test(text) : null;
  return { key, ok: c.ok, matched, ms: performance.now() - started };
});
parentPort!.postMessage(out);
