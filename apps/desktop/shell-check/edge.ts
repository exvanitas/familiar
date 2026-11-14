/* The positive control: the same hostile page in a headless Edge with no sink proxy, served by the
   driver's fixtures. Its traffic must reach the listeners and the capture, or the fixtures can't
   see, and the egress checks prove nothing. */
import { hostile, type HostileFixtures } from './hostile.ts';

(async () => {
  const fx = (await (await fetch('/fixtures.json', { cache: 'no-store' })).json()) as HostileFixtures;
  const out = await hostile('edge', fx, { nav: false });
  await fetch('/edge-result', { method: 'POST', body: JSON.stringify(out) });
})();
