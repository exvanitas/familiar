// One server's saved record, written by one writer: one write at a time, and writes asked for while one is
// under way coalesce into one more, which writes the record as it is then. So a storm of changes makes
// at most two writes, and an older picture of the record never lands after a newer one. Each request
// resolves once a write that began after it is durable. After `close`, nothing more is written.

export class CoalescedWriter {
  private readonly write: () => Promise<void>;
  private inflight = false;
  private waiting: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  private closed = false;
  private idle: (() => void)[] = [];

  constructor(write: () => Promise<void>) {
    this.write = write;
  }

  request(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The server is being removed.'));
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.kick();
    });
  }

  /** Writes nothing more, and resolves once the write under way, if any, is done. */
  close(): Promise<void> {
    this.closed = true;
    for (const w of this.waiting.splice(0)) w.reject(new Error('The server is being removed.'));
    return this.inflight ? new Promise(r => this.idle.push(r)) : Promise.resolve();
  }

  private kick(): void {
    if (this.inflight || this.closed || this.waiting.length === 0) return;
    const batch = this.waiting.splice(0);
    this.inflight = true;
    this.write().then(
      () => batch.forEach(w => w.resolve()),
      (e: unknown) => batch.forEach(w => w.reject(e))
    ).finally(() => {
      this.inflight = false;
      for (const r of this.idle.splice(0)) r();
      this.kick();
    });
  }
}
