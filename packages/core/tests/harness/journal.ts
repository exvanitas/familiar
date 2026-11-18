// The journal harness (docs/mcp-design.md 7.2, H6 to H9): the real journal on the real pi-durable, over a
// fake IndexedDB that outlives each life, with a gated fake model. At each step a seeded scheduler picks
// one ready event: a model request answered, one of your actions (a message, an answer with its button,
// Send now, her line), or a kill and reopen. Every commit is recorded at the storage boundary, across
// lives, with pi.live and pi.inbox rebuilt from what was stored; the driver keeps the evidence log of what
// you did and what was shown. The checks (journal-checks.ts) read only those two logs.

import { applyImmutable } from '@earendil-works/chord/delta';
import { mutations } from '../../src/mutations.ts';
import { decideByRules, openJournal, type FamiliarTool, type Journal, type ModelPort, type ModelRequest, type Question, type SendNowOffer } from '../../src/index.ts';
import type { FakeReply } from '../../src/testing/index.ts';
import { createFakeModel } from '../../src/testing/index.ts';
import { nodeWorld, type NodeWorld } from '../journal/node-env.ts';
import { fakeTools, offsetClock, type Env } from '../journal/scenarios.ts';
import { rng, settle } from './sched.ts';

/* ---------- the commit recorder, across lives ---------- */

export interface JCommit {
  readonly seq: number;
  readonly life: number;
  /** The scheduler step it landed in. */
  readonly step: number;
  readonly livePre: any;
  readonly livePost: any;
  readonly inboxPre: any;
  readonly inboxPost: any;
  readonly submissions: { id: string; type: string; status: string; reason?: string; detail?: unknown; requestId?: string }[];
  readonly entries: { id: string; kind: string; model: boolean; data: string }[];
  /** Familiar's documents this commit wrote, by kind. */
  readonly docs: string[];
  /** Familiar's documents this commit wrote, with their values after it (for the twin rule). */
  readonly docValues: Record<string, string>;
  /** Answer records this commit added (task ids), and Send now records (request ids). */
  readonly answered: string[];
  /** Send now records (SendNowDoc.byRequest) this commit wrote: the request, the offered submission, and
      what it started, if anything. */
  readonly sentNow: { request: string; submission: string; sent?: string }[];
  /** Interruption records this commit added (step ids). */
  readonly interrupted: string[];
}

function recorder() {
  const kinds = new Map<string, string>();
  const values = new Map<string, any>();
  const log: JCommit[] = [];
  let life = 0;
  let stepNow = 0;
  const liveOf = () => [...values.entries()].find(([id]) => kinds.get(id) === 'pi.live')?.[1];
  const inboxOf = () => [...values.entries()].find(([id]) => kinds.get(id) === 'pi.inbox')?.[1];
  return {
    log,
    setStep: (s: number) => void (stepNow = s),
    attach(storage: any, l: number) {
      life = l;
      const original = storage.commit.bind(storage);
      storage.commit = (batches: any[][], receive: (i: number, seq: any) => void, context: any) =>
        original(
          batches,
          (index: number, seq: any) => {
            const livePre = structuredClone(liveOf());
            const inboxPre = structuredClone(inboxOf());
            const docOf = (kind: string) => [...values.entries()].find(([id]) => kinds.get(id) === kind)?.[1];
            const answersPre = Object.keys(docOf('familiar.answers')?.byTask ?? {});
            const sentPre = Object.keys(docOf('familiar.send-now')?.byRequest ?? {});
            const stepsPre = Object.keys(docOf('familiar.interruptions')?.steps ?? {});
            const c: JCommit = { seq: Number(seq), life, step: stepNow, livePre, livePost: undefined, inboxPre, inboxPost: undefined, submissions: [], entries: [], docs: [], docValues: {}, answered: [], sentNow: [], interrupted: [] };
            for (const w of batches[index]!) {
              if (w.type === 'document.create') {
                kinds.set(String(w.record.id), w.record.kind);
                values.set(String(w.record.id), structuredClone(w.content.value));
                if (!String(w.record.kind).startsWith('pi.')) c.docs.push(w.record.kind);
              } else if (w.type === 'document.change') {
                const id = String(w.id);
                values.set(id, w.content.kind === 'base' ? structuredClone(w.content.value) : applyImmutable(values.get(id), w.content.ops));
                const k = kinds.get(id);
                if (k && !k.startsWith('pi.')) c.docs.push(k);
              } else if (w.type === 'submission') {
                const detail = w.value.detail ?? w.value.settlement?.detail;
                c.submissions.push({ id: String(w.value.id), type: w.value.type ?? w.value.draft?.type, status: w.value.status, reason: w.value.reason ?? w.value.settlement?.reason, ...(detail !== undefined ? { detail } : {}), requestId: w.value.requestId ?? w.value.draft?.requestId });
              } else if (w.type === 'entry') {
                c.entries.push({ id: String(w.value.id), kind: w.value.kind, model: w.value.model !== undefined, data: JSON.stringify([w.value.data ?? null, w.value.model ?? null]) });
              }
            }
            c.answered.push(...Object.keys(docOf('familiar.answers')?.byTask ?? {}).filter((k) => !answersPre.includes(k)));
            c.interrupted.push(...Object.keys(docOf('familiar.interruptions')?.steps ?? {}).filter((k) => !stepsPre.includes(k)));
            const byRequest = docOf('familiar.send-now')?.byRequest ?? {};
            c.sentNow.push(...Object.keys(byRequest).filter((k) => !sentPre.includes(k)).map((k) => ({ request: k, submission: String(byRequest[k].submission), ...(byRequest[k].sent ? { sent: String(byRequest[k].sent) } : {}) })));
            for (const k of c.docs) c.docValues[k] = JSON.stringify(docOf(k) ?? null);
            (c as any).livePost = structuredClone(liveOf());
            (c as any).inboxPost = structuredClone(inboxOf());
            log.push(c);
            receive(index, seq);
          },
          context
        );
    }
  };
}

/* ---------- the gated model ---------- */

interface Pending {
  readonly k: number;
  readonly life: number;
  readonly request: ModelRequest;
  release(reply: FakeReply): void;
}

/** A model port whose every request waits for the scheduler to answer it. */
function gatedModel(pending: Pending[], life: () => number): ModelPort {
  let k = 0;
  return {
    stream(request, signal) {
      let release!: (r: FakeReply) => void;
      const reply = new Promise<FakeReply>((r) => (release = r));
      pending.push({ k: ++k, life: life(), request, release });
      const fake = createFakeModel(() => ({ text: '' }));
      return (async function* () {
        const r = await reply;
        yield* createFakeModel(() => r).stream(request, signal);
        void fake;
      })();
    }
  };
}

/* ---------- the evidence log ---------- */

export interface JEvidence {
  readonly step: number;
  readonly what: 'send' | 'answer' | 'send-now' | 'remark' | 'kill' | 'shown';
  readonly requestId?: string;
  readonly question?: string;
  readonly yes?: boolean;
  readonly offer?: SendNowOffer;
  /** What was shown after the step: the questions and the Send now offer. */
  readonly questions?: readonly Question[];
  readonly sendNow?: SendNowOffer | undefined;
  /** The latest commit when it was shown. */
  readonly at?: number;
  readonly visible?: boolean;
}

export interface JRun {
  readonly log: JCommit[];
  readonly evidence: JEvidence[];
  readonly steps: string[];
  readonly firstHit: number | undefined;
  readonly stepCap: number;
  readonly problems: string[];
}

export interface JOptions {
  readonly mutation?: string;
  readonly steps?: number;
  /** A named schedule in place of the random actions. */
  readonly schedule?: (d: JDriver) => Promise<void>;
  /** The turn's token allowance, or false for none (a schedule that drives its own usage). */
  readonly turnTokens?: number | false;
}

const STEP_CAP = 2;
/** A turn's token allowance: a long turn pauses and asks (a cap question) in about half the seeds, and
    leaves room for the rest (Send now, superseded questions) as often as with no cap. */
const TURN_TOKENS = 4000;

/** A read that doesn't come back in time counts as nothing shown, and is reported. */
async function within<T>(p: Promise<T>, fallback: T, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((r) => (timer = setTimeout(() => r(fallback), ms)));
  try {
    return await Promise.race([p.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** One seeded run. */
export async function journalRun(seed: number, options: JOptions = {}): Promise<JRun> {
  mutations.set(options.mutation ? [options.mutation] : []);
  // The run's random ids (a card's presentation, a reservation's id, her line's key) come from the seed, so
  // a mutant and its twin write the same ones and the twin rule can compare what they wrote.
  const random = Math.random;
  Math.random = rng(seed * 104729 + 17);
  const d = new JDriver(seed, options.mutation, options.turnTokens ?? TURN_TOKENS);
  try {
    await d.open();
    if (options.schedule) await options.schedule(d);
    else await d.randomActions(options.steps ?? 40);
    await d.close();
  } finally {
    Math.random = random;
    mutations.clear();
  }
  return { log: d.rec.log, evidence: d.evidence, steps: d.steps, firstHit: d.firstHit, stepCap: STEP_CAP, problems: d.problems };
}

export class JDriver {
  readonly rand: () => number;
  readonly rec = recorder();
  readonly evidence: JEvidence[] = [];
  readonly steps: string[] = [];
  readonly problems: string[] = [];
  firstHit: number | undefined;
  private readonly mutation: string | undefined;
  private readonly world: NodeWorld = nodeWorld();
  private readonly pending: Pending[] = [];
  journal!: Journal;
  life = 0;
  private n = 0;
  private readonly seed: number;

  private readonly turnTokens: number | false;

  constructor(seed: number, mutation?: string, turnTokens: number | false = TURN_TOKENS) {
    this.seed = seed;
    this.rand = rng(seed);
    this.mutation = mutation;
    this.turnTokens = turnTokens;
  }

  /** The model's reply, a function of the seed and the request alone, so a twin run gets the same. */
  /** A named schedule's own model, in place of the seeded one. */
  script: ((request: ModelRequest) => FakeReply) | undefined;

  reply(request: ModelRequest): FakeReply {
    if (this.script) return this.script(request);
    const last = request.messages.at(-1);
    const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    const h = rng(this.seed * 7919 + request.messages.length * 31 + [...text].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381))();
    // Her line's own request has no tools: words only.
    if (!request.tools?.length) return { text: 'What a day.' };
    const toolResults = request.messages.filter((m) => m.role === 'tool').length;
    if (h < 0.55) return { toolCalls: [{ id: `c${toolResults}-${request.messages.length}`, name: h < 0.45 ? 'note_add' : 'look', arguments: h < 0.45 ? { text: `n${request.messages.length}` } : { what: `w${request.messages.length}` } }] };
    // Now and then the endpoint refuses (no retry helps): the run ends in an error, which asks nothing.
    if (h > 0.9) return { error: { kind: 'bad-request', message: 'refused' } as any };
    return { text: `Reply ${request.messages.length}.` };
  }

  async open(): Promise<void> {
    this.life++;
    const life = this.life;
    const env: Env = { life, counters: this.world.counters, owner: this.world.owner, openStore: this.world.open, ready: () => {}, onTransaction: () => () => {} };
    const store = await this.world.open('harness');
    this.rec.attach(store.storage, life);
    // `look` hangs, now and then, in this life only: a kill then cuts its step off.
    const tools: FamiliarTool[] = fakeTools(env, (name) => name === 'look' && this.rand() < 0.3);
    this.journal = await openJournal({
      store,
      owner: env.owner,
      model: gatedModel(this.pending, () => this.life),
      modelId: 'fake-1',
      caps: { config: { maxReplyTokens: 200, ...(this.turnTokens ? { maxTurnTokens: this.turnTokens } : {}) }, call: { persona: 'olive', price: { inputPerMTok: 1, outputPerMTok: 2 } } },
      tools,
      clock: offsetClock(this.world.counters),
      wake: { wakeAt: () => {} },
      consent: { ask: async () => true },
      presence: { report: () => {} },
      persona: { id: 'olive', name: 'Olive', instructions: 'You are Olive.' },
      decider: { decide: async (event, context) => decideByRules(event, context) },
      ambient: () => ({ persona: { sketch: 'kind', interests: [] }, chattiness: 'medium', doNotDisturb: false, fullscreen: false, sentAway: false, chatInFront: true, teaserDue: false }),
      stepCap: STEP_CAP,
      resendDelayMs: 1,
      notifier: { notify: () => {} }
    });
    await this.settle();
  }

  async close(): Promise<void> {
    // A close may wait on model requests still at the gate: the run ends here either way.
    this.journal.kill();
  }

  /** Lets the journal and pi-durable run until nothing moves (the model waits at its gate). */
  async settle(): Promise<void> {
    // Until nothing has moved for three rounds in a row: no commit, no new model request. Adaptive, so a
    // loaded machine waits longer rather than reading a half-settled state.
    let quiet = 0;
    let last = '';
    for (let i = 0; i < 200 && quiet < 3; i++) {
      await settle();
      await new Promise((r) => setTimeout(r, 2));
      const now = `${this.rec.log.length}:${this.pending.length}`;
      quiet = now === last ? quiet + 1 : 0;
      last = now;
    }
  }

  private async stepDone(label: string): Promise<void> {
    this.steps.push(label);
    this.rec.setStep(this.steps.length);
    await this.settle();
    if (this.firstHit === undefined && this.mutation && mutations.hits(this.mutation) > 0) this.firstHit = this.steps.length;
    // What's shown now, read as the screen would.
    const questions = await within(this.journal.questions(), []);
    const sendNow = await within(this.journal.queued(), undefined);
    this.evidence.push({ step: this.steps.length, what: 'shown', questions, sendNow, at: this.rec.log.at(-1)?.seq ?? 0 });
  }

  /* ---------- the events ---------- */

  /** Answers every model request at the gate, until none is left (or `max`). */
  async drain(max = 30): Promise<void> {
    for (let i = 0; i < max && (await this.awaitModel()) && (await this.answerModel()); i++);
  }

  /** Waits a while for a model request to reach the gate. */
  async awaitModel(tries = 25): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      if (this.pending.some((p) => p.life === this.life)) return true;
      await this.settle();
    }
    return false;
  }

  async answerModel(): Promise<boolean> {
    const mine = this.pending.filter((p) => p.life === this.life);
    if (!mine.length) return false;
    const p = mine[Math.floor(this.rand() * mine.length)]!;
    this.pending.splice(this.pending.indexOf(p), 1);
    this.rec.setStep(this.steps.length + 1);
    p.release(this.reply(p.request));
    await this.stepDone(`model:${p.k}`);
    return true;
  }

  async send(text?: string): Promise<void> {
    const requestId = `r${++this.n}`;
    this.rec.setStep(this.steps.length + 1);
    this.evidence.push({ step: this.steps.length + 1, what: 'send', requestId });
    void this.journal.send(text ?? `Message ${this.n}, please note it.`, requestId).catch(() => undefined);
    await this.stepDone(`send:${requestId}`);
  }

  /** A look at the screen once things have settled: a step of its own. */
  async look(): Promise<void> {
    await this.settle();
    await this.stepDone('look');
  }

  /** The question shown last, if any (a schedule may answer it later). */
  shownQuestion(): Question | undefined {
    return this.evidence.filter((e) => e.what === 'shown').at(-1)?.questions?.[0];
  }

  /** A question shown before the last one, as a late click or a resent answer would carry it. */
  olderQuestion(): Question | undefined {
    const last = this.shownQuestion()?.id;
    const older = [...new Set(this.evidence.flatMap((e) => (e.what === 'shown' ? (e.questions ?? []) : [])).filter((q) => q.id !== last).map((q) => JSON.stringify(q)))].map((q) => JSON.parse(q) as Question);
    return older.length ? older[Math.floor(this.rand() * older.length)] : undefined;
  }

  async answer(yes = this.rand() < 0.7, question?: Question): Promise<boolean> {
    // Now and then a late answer to a question shown earlier, which must answer nothing now.
    const shown = question ?? (this.rand() < 0.2 ? this.olderQuestion() : undefined) ?? this.shownQuestion();
    if (!shown) return false;
    const requestId = `a${++this.n}`;
    this.rec.setStep(this.steps.length + 1);
    this.evidence.push({ step: this.steps.length + 1, what: 'answer', requestId, question: shown.id, yes });
    void this.journal.answer(shown.id, yes, requestId).catch(() => undefined);
    await this.stepDone(`answer:${shown.id}:${yes ? 'yes' : 'no'}`);
    return true;
  }

  async sendNow(): Promise<boolean> {
    const offer = this.evidence.filter((e) => e.what === 'shown').at(-1)?.sendNow;
    if (!offer) return false;
    const requestId = `s${++this.n}`;
    this.rec.setStep(this.steps.length + 1);
    this.evidence.push({ step: this.steps.length + 1, what: 'send-now', requestId, offer });
    void this.journal.sendNow(offer, requestId).catch(() => undefined);
    await this.stepDone(`send-now:${offer.submission}`);
    return true;
  }

  async remark(): Promise<void> {
    this.rec.setStep(this.steps.length + 1);
    const step = this.steps.length + 1;
    void this.journal
      .remark({ system: 'Say one short thing.', messages: [{ role: 'user', content: 'Anything to say?' }] })
      .then((r) => this.evidence.push({ step, what: 'remark', visible: r?.visible }))
      .catch(() => undefined);
    await this.stepDone('remark');
  }

  async kill(): Promise<void> {
    this.rec.setStep(this.steps.length + 1);
    this.evidence.push({ step: this.steps.length + 1, what: 'kill' });
    this.journal.kill();
    // The old life's model requests die with it.
    for (const p of this.pending.filter((x) => x.life === this.life)) this.pending.splice(this.pending.indexOf(p), 1);
    await this.settle();
    await this.open();
    await this.stepDone(`kill:${this.life}`);
  }

  /** `k` steps, each one ready event picked by the seed. */
  async randomActions(k: number): Promise<void> {
    await this.send();
    for (let i = 0; i < k; i++) {
      const x = this.rand();
      // The model answers most steps; your actions come between, each only when the screen offers it.
      if (x < 0.6 && (await this.answerModel())) continue;
      const y = this.rand();
      if (y < 0.3) {
        if (!(await this.answer())) await this.send();
      } else if (y < 0.5) await this.send();
      else if (y < 0.7) {
        if (!(await this.sendNow())) await this.remark();
      } else if (y < 0.88) await this.remark();
      else await this.kill();
    }
    // Drain: answer what's pending, so the run ends somewhere quiet.
    for (let i = 0; i < 30 && (await this.answerModel()); i++);
  }
}
