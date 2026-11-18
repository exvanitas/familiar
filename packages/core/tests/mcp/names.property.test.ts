// A model name names one tool, for good (G25, 5.9). Random adds and removes of servers whose labels clash:
// each server's key is issued once against every key ever issued, so `<key>__<tool>` maps to one server
// id and one tool name for the whole history, whatever starts or stops. The control issues keys unique only
// among the servers saved now (tombstones forgotten), and the property must catch a name moving.
import { describe, expect, it } from 'vitest';
import { issueKey, modelName } from '../../src/mcp/owner.ts';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Issue = (label: string, everIssued: readonly string[], savedNow: readonly string[]) => string;
const right: Issue = (label, ever) => issueKey(label, ever);
const forgetful: Issue = (label, _ever, now) => issueKey(label, now);

function run(seed: number, issue: Issue): string[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const ever: string[] = [];
  const saved = new Map<string, string>(); // id -> key
  const owner = new Map<string, string>(); // model name -> "id/tool", for all time
  const problems: string[] = [];
  for (let i = 0; i < 30; i++) {
    if (r() < 0.6 || saved.size === 0) {
      const id = `srv-${seed}-${i}`;
      const key = issue(pick(['Same', 'Same', 'Files', '日本']), ever, [...saved.values()]);
      ever.push(key);
      saved.set(id, key);
      for (const tool of ['echo', 'read_file']) {
        const n = modelName(key, tool);
        if (!('name' in n)) continue;
        const who = `${id}/${tool}`;
        const was = owner.get(n.name.toLowerCase());
        if (was && was !== who) problems.push(`seed ${seed}: ${n.name} named ${was}, now ${who}`);
        owner.set(n.name.toLowerCase(), who);
      }
    } else {
      saved.delete(pick([...saved.keys()]));
    }
  }
  return problems;
}

describe('a model name names one tool, for good', () => {
  it('across 2000 seeded histories of adds and removes with clashing labels', () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 2000; seed++) problems.push(...run(seed, right));
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it('the control: keys unique only among the servers saved now let a name move, and are caught', () => {
    let caught = 0;
    for (let seed = 1; seed <= 2000; seed++) if (run(seed, forgetful).length) caught++;
    expect(caught).toBeGreaterThan(0);
  });
});
