/* pi-ai has a few `node:*` imports on branches that run only under Node or Bun (spikes/pi-ai-web,
   RESULT.md section 1). In a page they never run, so each bundles as an empty module. */
import type { Plugin } from 'esbuild';

export const nodeStub: Plugin = {
  name: 'node-stub',
  setup(b) {
    b.onResolve({ filter: /^node:/ }, a => ({ path: a.path, namespace: 'node-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({ contents: 'export default {};', loader: 'js' }));
  }
};
