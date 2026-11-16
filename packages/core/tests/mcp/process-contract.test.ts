// The process port's contract, against the Node adapter and the real fake server.
import { afterAll, describe, it } from 'vitest';
import { processPortContract } from '../../src/testing/index.ts';
import { BLANKED_VALUE, fakeSetup } from './fake.ts';
import { nodeProcessPort } from './node-process.ts';

const port = nodeProcessPort({ secret: (_id, name) => (name === 'FAKE_SECRET' ? BLANKED_VALUE : undefined) });
afterAll(() => port.closeAll());

describe('the process port contract, Node adapter', () => {
  for (const c of processPortContract) it(c.name, () => c.run({ port, setup: fakeSetup, secret: BLANKED_VALUE }));
});
