// Kill mid-step, in Node: the engine and its store connection torn down with no shutdown path, then a
// reopen and a resume on the same fake IndexedDB. The same scenarios and the same checks run in headless
// Chromium, with the page closed (browser.test.ts).
import { describe, it } from 'vitest';
import { CHECKS } from './checks.ts';
import { killAndResume } from './node-env.ts';
import { scenario } from './scenarios.ts';

describe('kill mid-step, then resume (Node, fake IndexedDB, the engine and its connection torn down)', () => {
  for (const [name, check] of Object.entries(CHECKS)) {
    it(`${name}: ${check.title}`, async () => {
      check.verify((await killAndResume(scenario(name))) as any);
    });
  }
});
