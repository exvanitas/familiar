// The security gate. Two namespaces, two lists, one rule each:
//   security.<id>  every id in security-inventory.json must report PASS. A FAIL, a SKIP, or a listed
//                  id that never reported fails the gate. An id reported twice must PASS both times.
//   check.<id>     every id in checks.json may PASS or SKIP. A FAIL fails the run.
// Any reported id in neither list, in either namespace, fails the run, so a renamed or new check
// can't slip past. The egress verdicts come from an analysis of this run's capture: each must carry
// `run=<id>` matching the driver's `RUN <id>` line, so one left from another run fails.
//
//   node gate.mjs <results file>...
import { appendFileSync, readFileSync } from 'node:fs';

export function judge(lines, inventory, checks) {
  const seen = new Map();
  const problems = [];
  const runs = lines.map(l => /^RUN ([a-z0-9]+)\s*$/.exec(l.trim())?.[1]).filter(Boolean);
  if (runs.length > 1) problems.push(`more than one RUN line: ${runs.join(' ')}`);
  for (const raw of lines) {
    const m = /^(PASS|FAIL|SKIP) (\S+) ?(.*)$/.exec(raw.trim());
    if (!m) continue;
    const [, state, id, detail] = m;
    if (!seen.has(id)) seen.set(id, []);
    seen.get(id).push({ state, detail });
  }
  for (const [id, reports] of seen) {
    const states = reports.map(r => r.state);
    if (id.startsWith('security.')) {
      const name = id.slice('security.'.length);
      if (!inventory.includes(name)) problems.push(`${id}: not in the security inventory`);
      else if (states.some(s => s !== 'PASS')) problems.push(`${id}: ${states.join('/')}: ${reports.find(r => r.state !== 'PASS').detail}`);
      else if (id.startsWith('security.egress.') && !(runs.length === 1 && reports.every(r => r.detail.endsWith(` run=${runs[0]}`)))) {
        problems.push(`${id}: not from this run's analysis`);
      }
    } else if (id.startsWith('check.')) {
      const name = id.slice('check.'.length);
      if (!checks.includes(name)) problems.push(`${id}: not in checks.json`);
      else if (states.includes('FAIL')) problems.push(`${id}: FAIL: ${reports.find(r => r.state === 'FAIL').detail}`);
    } else {
      problems.push(`${id}: no namespace`);
    }
  }
  for (const name of inventory) if (!seen.has(`security.${name}`)) problems.push(`security.${name}: never reported`);
  const count = s => [...seen.values()].flat().filter(r => r.state === s).length;
  return { ok: problems.length === 0, problems, pass: count('PASS'), fail: count('FAIL'), skip: count('SKIP'), ids: seen.size };
}

if (process.argv[1]?.endsWith('gate.mjs')) {
  const here = new URL('.', import.meta.url);
  const inventory = JSON.parse(readFileSync(new URL('security-inventory.json', here), 'utf8')).ids;
  const checks = JSON.parse(readFileSync(new URL('checks.json', here), 'utf8')).ids;
  const lines = process.argv.slice(2).flatMap(f => readFileSync(f, 'utf8').split('\n'));
  const r = judge(lines, inventory, checks);
  const security = lines.filter(l => / security\./.test(` ${l}`) && /^(PASS|FAIL|SKIP) /.test(l)).sort((a, b) => a.split(' ')[1].localeCompare(b.split(' ')[1]));
  const summary = [
    '### Security gate',
    r.ok ? `**PASS**: all ${inventory.length} security ids passed, ${r.ids} ids reported` : `**FAIL**: ${r.problems.length} problems`,
    '',
    ...r.problems.map(p => `- ${p}`),
    '',
    `${r.pass} PASS, ${r.fail} FAIL, ${r.skip} SKIP`,
    '',
    '```',
    ...security.map(l => l.slice(0, 400)),
    '```'
  ].join('\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  process.exit(r.ok ? 0 : 1);
}
