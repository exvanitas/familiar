// The card desk (docs/mcp-design.md 5.7): the journal's consent port, as the core page holds it, with the
// cards it's showing and the one way another window answers them. An answer from another window is
// untrusted: it carries only the card's presentation id and one button, and nothing else in it is read.
// Each presentation is answered at most once; an answer for a presentation that isn't showing (retired by
// a change, already answered, or never shown) answers nothing. A button the card didn't offer is a Skip.

import { mutant } from '../mutations.ts';
import type { ConsentCard, ConsentPort } from './journal.ts';

export type CardButton = 'yes' | 'own' | 'skip';

/** The buttons a card offers: "May run on its own" only on a server tool's card, which carries its words. */
export function buttonsOf(card: ConsentCard): readonly CardButton[] {
  return card.own ? ['yes', 'own', 'skip'] : ['yes', 'skip'];
}

/** What answering did: `answered` (and with what), or `ignored`, with nothing changed. */
export type DeskResult = { readonly kind: 'answered'; readonly yes: boolean; readonly own: boolean } | { readonly kind: 'ignored' };

export interface CardDesk {
  /** The journal's consent port. */
  readonly port: ConsentPort;
  /** The cards showing now, each with its buttons, oldest first. */
  showing(): readonly { readonly card: ConsentCard; readonly buttons: readonly CardButton[] }[];
  /** An answer from another window: `{ presentation, button }`, read and nothing more. */
  answer(message: unknown): DeskResult;
}

const MAX_ID = 64;

/** A "May run on its own" press answers the card `own`, offered only on a card that carries its words. No card
    does in step 7: step 8 has the desk issue the grant at the press (5.6). */
export function createCardDesk(): CardDesk {
  const pending = new Map<string, { readonly card: ConsentCard; readonly settle: (yes: boolean) => void }>();
  // For a named mutation only: the step each presentation was for.
  const stepOf = new Map<string, string>();
  return {
    port: {
      ask(card, signal) {
        return new Promise<boolean>((resolve) => {
          const p = card.presentation;
          // A card with no presentation id can't be answered from outside: it's never shown here.
          if (!p) return resolve(false);
          if (__FAMILIAR_MUTATIONS__) stepOf.set(p, card.id);
          const settle = (yes: boolean) => {
            if (pending.get(p)?.settle !== settle) return;
            pending.delete(p);
            resolve(yes);
          };
          pending.set(p, { card, settle });
          signal?.addEventListener('abort', () => settle(false), { once: true });
        });
      }
    },
    showing: () => [...pending.values()].map(({ card }) => ({ card, buttons: buttonsOf(card) })),
    answer(message) {
      if (typeof message !== 'object' || message === null) return { kind: 'ignored' };
      const presentation = (message as { presentation?: unknown }).presentation;
      const button = (message as { button?: unknown }).button;
      if (typeof presentation !== 'string' || presentation.length > MAX_ID || typeof button !== 'string') return { kind: 'ignored' };
      let entry = pending.get(presentation);
      // The named mutation: answers keyed by the card's step, so an old presentation answers its successor.
      if (!entry && (__FAMILIAR_MUTATIONS__ && mutant('answers-by-step'))) entry = [...pending.values()].find((e) => e.card.id === stepOf.get(presentation));
      if (!entry) return { kind: 'ignored' };
      const offered = (buttonsOf(entry.card) as readonly string[]).includes(button);
      const yes = offered && (button === 'yes' || button === 'own');
      const own = offered && button === 'own';
      entry.settle(yes);
      return { kind: 'answered', yes, own };
    }
  };
}
