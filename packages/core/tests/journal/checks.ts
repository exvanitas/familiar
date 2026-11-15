// What each kill scenario must show after the restart: the resume table, row by row. Node and Chromium
// run the same checks on the summary their life 2 returned.
import { expect } from 'vitest';

export interface Check {
  readonly title: string;
  verify(s: any): void;
}

const toolResult = (s: any) => s.transcript.find((e: any) => e.role === 'toolResult');
const requestsAfterUser = (s: any) => s.requestsSent;

export const CHECKS: Record<string, Check> = {
  'model-finished': {
    title: 'a model call that finished is replayed from its record: no new request for it',
    verify(s) {
      expect(s.end).toMatchObject({ status: 'answered' });
      // One request in life 1 (the tool call), one in life 2 (after the tool). Never the first again.
      expect(s.modelRequests).toBe(2);
      expect(requestsAfterUser(s)).toBe(1);
      expect(s.transcript.filter((e: any) => e.role === 'assistant' && /\[look/.test(e.text))).toHaveLength(1);
    }
  },
  'read-started': {
    title: 'a read that had started is run again',
    verify(s) {
      expect(s.end).toMatchObject({ status: 'answered' });
      expect(s.starts).toBe(2);
      expect(toolResult(s).text).toBe('seen: the time');
    }
  },
  'write-started': {
    title: 'a built-in write that had started is run again, and its write, keyed by its step, is committed once',
    verify(s) {
      expect(s.end).toMatchObject({ status: 'answered' });
      expect(s.starts).toBe(2);
      // Counted in the store: one committed row, made in life 1 (the kill came after its commit).
      expect(s.rows).toEqual([expect.objectContaining({ text: 'buy milk', token: 'buy milk#life1' })]);
      // The rerun found its receipt: it got life 1's token back, and its change never ran.
      expect(toolResult(s).text).toBe('saved: buy milk (buy milk#life1)');
      expect(s.writeCalls).toEqual([1, 0]);
    }
  },
  'effect-started': {
    title: 'a built-in effect that had started is not run: it becomes a question, "Do it now?"',
    verify(s) {
      expect(s.starts).toBe(1);
      expect(s.questions).toEqual([expect.objectContaining({ kind: 'redo', tool: 'send_message', text: 'I was sending a message to Sam when the app closed. Do it now?' })]);
      expect(toolResult(s).text).toMatch(/not run again/);
      expect(s.end).toMatchObject({ status: 'answered' });
      // Yes: she does it now, as a new step that asks first again.
      expect(s.redo).toMatchObject({ status: 'answered' });
      expect(s.startsAfterRedo).toBe(2);
      expect(s.questionsAfter).toEqual([]);
    }
  },
  'server-started': {
    title: 'a server tool that had started is never repeated: reported as interrupted, with Run again',
    verify(s) {
      expect(s.starts).toBe(1);
      expect(s.questions).toEqual([expect.objectContaining({ kind: 'rerun', tool: 'server_lookup', text: expect.stringMatching(/may have partially run/) })]);
      expect(toolResult(s).text).toMatch(/interrupted and may have partially run/);
      expect(s.end).toMatchObject({ status: 'answered' });
    }
  },
  'replay-restart': {
    title: "a reply's replay state is stored with its entry and given back unchanged on the next request, after a restart",
    verify(s) {
      expect(s.end).toMatchObject({ status: 'answered', text: 'With the thinking, done.' });
      expect(s.ok).toBe(1);
      expect(s.missing).toBe(0);
    }
  },
  'tool-finished': {
    title: 'a tool that finished has its result reused; the model call after it is sent again',
    verify(s) {
      expect(s.end).toMatchObject({ status: 'answered' });
      expect(s.starts).toBe(1);
      expect(s.consentAsks).toBe(1);
      expect(s.modelRequests).toBe(3);
      expect(toolResult(s).text).toBe('sent to Ana');
    }
  },
  'model-in-flight': {
    title: 'a model call killed mid-stream is sent again; its open cap reservation stays spent and the new call takes its own',
    verify(s) {
      expect(s.end).toMatchObject({ status: 'answered', text: 'Here is the whole answer.' });
      // Life 1's cut-off request, its resend, and the later turn's.
      expect(s.modelRequests).toBe(3);
      // The partial is kept as an aborted entry.
      expect(s.transcript.some((e: any) => e.role === 'assistant' && e.error === 'aborted' && e.text.startsWith('Let me'))).toBe(true);
      // Right after the resend: the old reservation still open and counted, the new call settled on its own.
      expect(s.oldReservation).toBeTruthy();
      expect(s.afterResend.open.map((r: any) => r.id)).toEqual([s.oldReservation]);
      expect(s.afterResend.records).toEqual([expect.objectContaining({ tokens: 46 })]);
      expect(s.afterResend.records[0].reservation).not.toBe(s.oldReservation);
      // Past its deadline it's a spent record, at what was reserved.
      expect(s.later.open).toEqual([]);
      expect(s.later.records.find((r: any) => r.reservation === s.oldReservation)).toMatchObject({ tokens: s.reservedTokens });
    }
  },
  'consent-parked': {
    title: 'a consent card still open is there after a restart, asked again, and the tool runs once, after the answer',
    verify(s) {
      expect(s.cardsAtOpen).toEqual([expect.objectContaining({ id: s.lifeOneCard, tool: 'send_message', doing: 'sending a message to Sam' })]);
      expect(s.consentAsks).toBe(2);
      expect(s.starts).toBe(1);
      expect(s.end).toMatchObject({ status: 'answered' });
      expect(s.cardsAfter).toEqual([]);
      expect(s.states).toContain('waiting');
    }
  },
  'wake-parked': {
    title: 'a parked wake survives a restart: still asked of the wake port, and fires once when due',
    verify(s) {
      expect(s.lifeOneWakes).toBeGreaterThanOrEqual(1);
      expect(s.askedAgain).toBe(true);
      expect(s.firedEarly).toBe(0);
      expect(s.delivered).toBe(1);
      expect(s.lateMs).toBeGreaterThanOrEqual(0);
      expect(s.wakesAfter).toBeUndefined();
    }
  }
};
