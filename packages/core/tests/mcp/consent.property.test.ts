// Consent by identity, under label clashes. Random servers whose labels and tool names clash, random
// "always" and "never" choices keyed by identity, a Ready set that changes from turn to turn, and turns
// that keep the wrappers they were given. A call goes out without asking only if the person's choice for
// the wrapper's own identity (server id and tool name) allows it with both fingerprints matching, and then
// the server must still offer exactly that tool from that setup. A control builds the gate's policy the
// wrong way, by name across the current servers, and the property must catch it.
import { describe, expect, it } from 'vitest';
import { gateFor, type ToolPolicy } from '../../src/journal/gate.ts';
import { choiceKey, modelNames, serverTool, toolPolicies, type ServerTool, type ToolChoice } from '../../src/mcp/server-tools.ts';

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

interface Server { id: string; label: string; setup: string; tools: Map<string, string> }

type PolicyBuilder = (held: readonly ServerTool[], current: readonly ServerTool[], choices: Record<string, ToolChoice>) => Record<string, ToolPolicy>;
const right: PolicyBuilder = (held, _current, choices) => toolPolicies(held, choices);
/** The bug review found: a policy from the current servers' wrappers, matched to held ones by name. */
const byName: PolicyBuilder = (_held, current, choices) => toolPolicies(current, choices);

function run(seed: number, build: PolicyBuilder): string[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const servers: Server[] = Array.from({ length: 2 + Math.floor(r() * 3) }, (_, i) => ({
    id: pick(['a', 'z', 'm', 'q']) + i,
    label: pick(['Same', 'Same', 'Other']),
    setup: pick(['s1', 's2']),
    tools: new Map(['echo', 'note'].map(n => [n, pick(['f1', 'f2'])]))
  }));
  const choices: Record<string, ToolChoice> = {};
  let ready = servers.filter(() => r() < 0.6);
  const wrappers = (set: Server[]): ServerTool[] => {
    const names = modelNames(set.map(s => ({ id: s.id, label: s.label, tools: [...s.tools.keys()].map(name => ({ name })) })));
    return set.flatMap(s => [...s.tools].map(([name, fp]) => serverTool({
      server: { id: s.id, label: s.label },
      listed: { name, inputSchema: { type: 'object' }, fingerprint: fp },
      modelName: names.get(s.id)!.get(name)!,
      setupFingerprint: s.setup,
      fresh: false,
      call: async () => ({ kind: 'result', text: '', isError: false })
    })));
  };
  const turns: ServerTool[][] = [wrappers(ready)];
  const problems: string[] = [];
  for (let i = 0; i < 40; i++) {
    const x = r();
    if (x < 0.2) {
      const s = pick(servers);
      const t = pick([...s.tools.keys()]);
      const stale = r() < 0.3;
      choices[choiceKey(s.id, t)] = { policy: r() < 0.75 ? 'allow' : 'deny', fingerprint: stale ? 'old' : s.tools.get(t)!, setupFingerprint: s.setup };
    } else if (x < 0.35) {
      ready = servers.filter(() => r() < 0.6);
    } else if (x < 0.45) {
      const s = pick(servers);
      s.tools.set(pick([...s.tools.keys()]), pick(['f1', 'f2', 'f3']));
    } else if (x < 0.55) {
      turns.push(wrappers(ready));
    } else {
      // A turn, old or new, calls one of the wrappers it holds.
      const held = pick(turns);
      if (!held.length) continue;
      const w = pick(held);
      const policy = build(held, wrappers(ready), choices);
      if (gateFor(w.name, w, { perTool: policy }) !== 'allow') continue;
      const choice = choices[choiceKey(w.server.id, w.serverName)];
      if (!choice || choice.policy !== 'allow' || choice.fingerprint !== w.fingerprint || choice.setupFingerprint !== w.setupFingerprint) {
        problems.push(`seed ${seed}: ${w.name} of ${w.server.id} ran without asking, with choice ${JSON.stringify(choice)}`);
      }
      // At the send the actor checks the server still offers exactly this tool from this setup.
      const s = servers.find(v => v.id === w.server.id)!;
      const sent = ready.includes(s) && s.setup === w.setupFingerprint && s.tools.get(w.serverName) === w.fingerprint;
      if (sent && choice?.fingerprint !== s.tools.get(w.serverName)) problems.push(`seed ${seed}: sent a changed tool`);
    }
  }
  return problems;
}

describe('consent by identity, under label clashes', () => {
  it('a call runs without asking only if its own identity was allowed, with both fingerprints', () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 3000; seed++) problems.push(...run(seed, right));
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it('the control: a policy built by name across the current servers is caught', () => {
    let caught = 0;
    for (let seed = 1; seed <= 3000; seed++) if (run(seed, byName).length) caught++;
    expect(caught).toBeGreaterThan(0);
  });
});
