/* Every page of the app folder carries the Trusted Types rule in its own CSP, so a string assigned
   to an HTML or script sink throws. The check app's pages carry it too, except the two that exist
   to work without it. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const TT = `<meta http-equiv="Content-Security-Policy" content="require-trusted-types-for 'script'; trusted-types 'none'">`;
/* Pages without it, on purpose. */
const BARE: Record<string, string> = {
  'shell-check/pages/bare.html': "a view that tests the exe's own CSP alone",
  'shell-check/pages/edge.html': 'the Edge control, served outside Familiar'
};

function pages(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap(f => {
    const rel = `${dir}/${f}`;
    if (statSync(join(root, rel)).isDirectory()) return pages(rel);
    return f.endsWith('.html') ? [rel] : [];
  });
}

describe('Trusted Types on every page', () => {
  const all = [...pages('app'), ...pages('shell-check/pages'), ...pages('shell-check/broken')];

  it('finds the pages', () => {
    expect(all).toContain('app/core.html');
    expect(all).toContain('app/settings.html');
    expect(all).toContain('app/chat.html');
  });

  for (const page of all) {
    it(page, () => {
      const html = readFileSync(join(root, page), 'utf8');
      if (BARE[page]) {
        expect(html).not.toContain('trusted-types');
        return;
      }
      expect(html).toContain(TT);
      // Before any script, so it's in force when the first one runs.
      const script = html.indexOf('<script');
      expect(script < 0 || html.indexOf(TT) < script).toBe(true);
      // No inline script and no handler attributes: the exe's CSP would refuse them anyway.
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      expect(html).not.toMatch(/\son[a-z]+=/i);
    });
  }

  it('the real app folder has no page without it', () => {
    expect(Object.keys(BARE).filter(p => p.startsWith('app/'))).toEqual([]);
  });
});
