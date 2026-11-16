// The security gate. Two namespaces, two lists, one rule each:
//   security.<id>  every id in security-inventory.json must report PASS. A FAIL, a SKIP, or a listed
//                  id that never reported fails the gate. An id reported twice must PASS both times.
//   check.<id>     every id in checks.json may PASS or SKIP. A FAIL fails the run.
// Any reported id in neither list, in either namespace, fails the run, so a renamed or new check
// can't slip past.
//
// Known gaps: a security id marked in the inventory's `knownGaps`, with its reason, is a gap the release
// must close. In everyday runs it's reported as KNOWN GAP, printed and counted, and never fails, whatever
// it reports. In release mode (`--release`, or FAMILIAR_GATE_RELEASE=1) every mark still present fails,
// so a gap can't ship. Closing one means making it pass and removing its mark. The egress verdicts come from an analysis of this run's capture: each must carry
// `run=<id>` matching the driver's `RUN <id>` line, so one left from another run fails.
//
//   node gate.mjs [--release] <results file>...
import { appendFileSync, readFileSync } from 'node:fs';

export function judge(lines, inventory, checks, { knownGaps = {}, release = false } = {}) {
  const seen = new Map();
  const problems = [];
  const gaps = [];
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
      else if (Object.hasOwn(knownGaps, name)) continue;
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
  for (const name of inventory) if (!seen.has(`security.${name}`) && !Object.hasOwn(knownGaps, name)) problems.push(`security.${name}: never reported`);
  for (const [name, reason] of Object.entries(knownGaps)) {
    const states = (seen.get(`security.${name}`) ?? []).map(r => r.state);
    const line = `security.${name}: KNOWN GAP (${reason}): ${states.length ? states.join('/') : 'never reported'}`;
    gaps.push(line);
    if (!inventory.includes(name)) problems.push(`security.${name}: marked as a known gap but not in the inventory`);
    if (typeof reason !== 'string' || reason.trim() === '') problems.push(`security.${name}: a known gap with no reason`);
    if (release) problems.push(`${line}: a release can't ship with an open known gap`);
  }
  const count = s => [...seen.values()].flat().filter(r => r.state === s).length;
  return { ok: problems.length === 0, problems, gaps, pass: count('PASS'), fail: count('FAIL'), skip: count('SKIP'), ids: seen.size };
}

if (process.argv[1]?.endsWith('gate.mjs')) {
  const here = new URL('.', import.meta.url);
  const inv = JSON.parse(readFileSync(new URL('security-inventory.json', here), 'utf8'));
  const inventory = inv.ids;
  const checks = JSON.parse(readFileSync(new URL('checks.json', here), 'utf8')).ids;
  const args = process.argv.slice(2);
  const release = args.includes('--release') || process.env.FAMILIAR_GATE_RELEASE === '1';
  const lines = args.filter(a => a !== '--release').flatMap(f => readFileSync(f, 'utf8').split('\n'));
  const r = judge(lines, inventory, checks, { knownGaps: inv.knownGaps ?? {}, release });
  const security = lines.filter(l => / security\./.test(` ${l}`) && /^(PASS|FAIL|SKIP) /.test(l)).sort((a, b) => a.split(' ')[1].localeCompare(b.split(' ')[1]));
  const summary = [
    '### Security gate',
    r.ok ? `**PASS**${release ? ' (release)' : ''}: all ${inventory.length - r.gaps.length} security ids passed, ${r.ids} ids reported` : `**FAIL**${release ? ' (release)' : ''}: ${r.problems.length} problems`,
    '',
    ...r.problems.map(p => `- ${p}`),
    ...(r.gaps.length ? ['', `${r.gaps.length} known gap${r.gaps.length === 1 ? '' : 's'}, which a release can't ship with:`, ...r.gaps.map(g => `- ${g}`)] : []),
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
