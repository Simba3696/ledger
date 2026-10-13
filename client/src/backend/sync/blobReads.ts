// Blob reads a few at a time (design section 7: a cold start reads "4 at a
// time"). A reader that decides file by file, in a fixed order, plans the
// reads it is sure to make, in that order; they start ahead of it, at most
// `limit` in flight, and each is handed over only when the reader asks for
// it. The reader still takes each file in its own order and decides on it
// as before, so what it joins, halts and records doesn't depend on which
// answer came back first; only the waiting overlaps.

/** At most this many blob reads in flight at once (design section 7). */
export const BLOB_READS_AT_ONCE = 4;

interface Read {
  sha: string;
  /** The reader asked for it: it starts even after the plan was dropped. */
  asked: boolean;
  started: boolean;
  promise: Promise<string>;
  resolve: (text: string) => void;
  reject: (err: unknown) => void;
}

export class BlobReads {
  readonly #read: (sha: string) => Promise<string>;
  readonly #limit: number;
  #active = 0;
  /** Reads not yet handed over, by sha, in the order they were planned. */
  readonly #bySha = new Map<string, Read[]>();
  /** Reads not yet started, in the order they start. */
  #waiting: Read[] = [];
  /** No planned read starts any more: one failed (the reader stops at it,
   * and would never have sent the ones after it), or the reader is done. */
  #dropped = false;

  constructor(read: (sha: string) => Promise<string>, limit = BLOB_READS_AT_ONCE) {
    this.#read = read;
    this.#limit = limit;
  }

  /** Reads the reader will make, in the order it will make them. Each sha
   * is one read: a sha planned twice is read twice, as the reader would. */
  plan(shas: Iterable<string>): void {
    if (this.#dropped) return;
    for (const sha of shas) {
      const read = this.#entry(sha, false);
      const queued = this.#bySha.get(sha);
      if (queued) queued.push(read);
      else this.#bySha.set(sha, [read]);
      this.#waiting.push(read);
    }
    this.#pump();
  }

  /** The blob's text: the earliest planned read of it, handed over once,
   * or else a read of its own, which starts ahead of every planned one. */
  read(sha: string): Promise<string> {
    const queued = this.#bySha.get(sha);
    const planned = queued?.shift();
    if (queued?.length === 0) this.#bySha.delete(sha);
    if (planned) {
      planned.asked = true;
      if (!planned.started) {
        this.#waiting = [planned, ...this.#waiting.filter((r) => r !== planned)];
        this.#pump();
      }
      return planned.promise;
    }
    const own = this.#entry(sha, true);
    this.#waiting.unshift(own);
    this.#pump();
    return own.promise;
  }

  /** The reader is done: planned reads that haven't started never will.
   * Reads in flight finish, and their answers are dropped. */
  close(): void {
    this.#drop();
  }

  #entry(sha: string, asked: boolean): Read {
    let resolve!: (text: string) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A planned read the reader never asks for may fail unobserved.
    promise.catch(() => undefined);
    return { sha, asked, started: false, promise, resolve, reject };
  }

  #drop(): void {
    this.#dropped = true;
    this.#waiting = this.#waiting.filter((r) => r.asked);
  }

  #pump(): void {
    while (this.#active < this.#limit && this.#waiting.length > 0) {
      const read = this.#waiting.shift()!;
      if (this.#dropped && !read.asked) continue;
      read.started = true;
      this.#active++;
      let started: Promise<string>;
      try {
        started = this.#read(read.sha);
      } catch (err) {
        started = Promise.reject(err);
      }
      started.then(read.resolve, (err: unknown) => {
        this.#drop();
        read.reject(err);
      }).finally(() => {
        this.#active--;
        this.#pump();
      });
    }
  }
}
