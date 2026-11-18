/* Restart-only: a refused shell_ready builds nothing (5.3). */
import { describe, expect, it } from 'vitest';
import { boot, RESTART_WORDS } from '../src/app/boot.ts';

describe('restart-only', () => {
  it('a fresh exe says ready, then builds', async () => {
    const steps: string[] = [];
    expect(await boot(async () => void steps.push('ready'), async () => void steps.push('build'), () => void steps.push('refused'))).toEqual({ ok: true });
    expect(steps).toEqual(['ready', 'build']);
  });

  it('a reload in a running exe: ready is refused, nothing is built, and the page says it needs a restart', async () => {
    const steps: string[] = [];
    const r = await boot(async () => { throw { kind: 'refused', message: 'already ready' }; }, async () => void steps.push('build'), w => void steps.push(w));
    expect(r).toEqual({ ok: false, words: RESTART_WORDS });
    expect(steps).toEqual([RESTART_WORDS]);
  });
});
