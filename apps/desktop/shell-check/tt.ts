/* Trusted Types, tried from a page that carries the app's `<meta>`:
   `require-trusted-types-for 'script'; trusted-types 'none'`. Every HTML and script sink must
   throw. The design names five that must; the rest are the same rule and are held to it too. */

declare const trustedTypes: { createPolicy(name: string, rules: object): unknown } | undefined;

export const MUST_THROW = [
  'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval', 'Function', 'createPolicy',
  'script.text', 'script.src', 'iframe.srcdoc', 'DOMParser', 'createContextualFragment'
];

export function trySinks(): Record<string, string> {
  const out: Record<string, string> = {};
  const t = (k: string, f: () => unknown) => {
    try { f(); out[k] = 'allowed'; } catch (e) { out[k] = 'threw:' + (e instanceof Error ? e.name : typeof e); }
  };
  const host = document.createElement('div');
  document.body.append(host);
  const inner = document.createElement('span');
  host.append(inner);
  t('innerHTML', () => { host.innerHTML = '<b>x</b>'; });
  t('outerHTML', () => { inner.outerHTML = '<b>x</b>'; });
  t('insertAdjacentHTML', () => host.insertAdjacentHTML('beforeend', '<b>x</b>'));
  // Allowed, this would replace the page. A page that's gone fails the check by never answering.
  t('document.write', () => document.write('<b>x</b>'));
  t('eval', () => (0, eval)('1'));
  t('Function', () => new Function('return 1'));
  t('createPolicy', () => {
    if (typeof trustedTypes === 'undefined') throw new ReferenceError('no trustedTypes');
    return trustedTypes.createPolicy('x', { createHTML: (s: string) => s });
  });
  t('script.text', () => { document.createElement('script').text = '1'; });
  t('script.src', () => { document.createElement('script').src = 'x.js'; });
  t('iframe.srcdoc', () => { document.createElement('iframe').srcdoc = '<b>x</b>'; });
  t('DOMParser', () => new DOMParser().parseFromString('<b>x</b>', 'text/html'));
  t('createContextualFragment', () => document.createRange().createContextualFragment('<b>x</b>'));
  host.remove();
  return out;
}

/* The sinks that didn't throw. */
export const allowed = (r: Record<string, string>) => MUST_THROW.filter(k => !String(r[k]).startsWith('threw:'));
