// The caps ledger in the journal's store: one Session document, changed only in commits.
//
// pi-durable's Session runs one job at a time on its line, a commit's callback and its settlement, so a
// commit that reads the ledger and writes it is atomic against every other commit of this Harness. The
// journal holds its database under an owner lock (owner.ts), so no second Harness, in this page or
// another, writes the same store meanwhile: a second instance waits for the lock, and a reload releases
// it with the page. Commits are stored before they resolve, so a reservation is on disk before its call
// is sent.

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc } from '@earendil-works/pi-durable';
import type { Ledger, UsageStore } from '../model/caps.ts';
import { emptyLedger } from '../model/caps.ts';
import { resumableTurns, TurnsDoc } from './turns.ts';

export const LedgerDoc = defineDoc<Ledger & Record<string, any>>({
  kind: 'familiar.caps-ledger',
  version: 1,
  scope: 'session',
  initial: () => emptyLedger(),
  // The ledger is small and rewritten whole, so each change is stored as a complete value.
  checkpointWhen: () => true
});

/** What the ledger needs of a Harness: a commit and a read of committed documents. */
export interface LedgerHost {
  commit<T>(change: (tx: any) => T | Promise<T>, context: typeof BACKGROUND_CONTEXT): Promise<T>;
  snapshot(token: typeof LedgerDoc, context: typeof BACKGROUND_CONTEXT): Promise<Readonly<Ledger> | undefined>;
}

const plain = (value: unknown): Ledger => {
  const l = JSON.parse(JSON.stringify(value ?? emptyLedger()));
  return { records: l.records ?? [], open: l.open ?? [], turns: l.turns ?? {}, extensions: l.extensions ?? {}, granted: l.granted ?? {} };
};

/**
 * The turns that can still resume, read in the ledger's own commit. The journal passes its live read
 * (pi.live, cards, queued submissions); without one, the registry's open marks stand in.
 */
export type ResumableRead = (tx: any) => Promise<readonly string[]>;

export function journalUsageStore(host: LedgerHost, resumable: ResumableRead = async (tx) => resumableTurns(await tx.doc(TurnsDoc))): UsageStore {
  return {
    async update(change) {
      return host.commit(async (tx) => {
        const doc = await tx.doc(LedgerDoc);
        const ledger = plain(doc);
        const before = JSON.stringify(ledger);
        // The turns that can still resume, read in this same commit, so tidy keeps them whole.
        ledger.resumable = [...(await resumable(tx))];
        // A throw rolls the commit back.
        const out = change(ledger);
        delete ledger.resumable;
        if (JSON.stringify(ledger) !== before) {
          doc.records = ledger.records;
          doc.open = ledger.open;
          doc.turns = ledger.turns;
          doc.extensions = ledger.extensions;
          doc.granted = ledger.granted;
        }
        return out;
      }, BACKGROUND_CONTEXT);
    },
    async read() {
      return plain(await host.snapshot(LedgerDoc, BACKGROUND_CONTEXT));
    }
  };
}
