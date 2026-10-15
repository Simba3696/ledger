import { describe, expect, it } from "vitest";
import { BLOB_READS_AT_ONCE, BlobReads } from "./blobReads";

// BlobReads (design section 7, "4 at a time"): planned reads start ahead of
// the reader, at most the limit in flight, in the order planned; each is
// handed over once, when asked for; a read not planned goes first; and once
// one fails or the reader is done, no planned read starts.

/** A blob store whose reads the test answers by hand. */
class Remote {
  readonly started: string[] = [];
  readonly #pending = new Map<string, { resolve: (text: string) => void; reject: (err: unknown) => void }[]>();
  inFlight = 0;
  peak = 0;

  read = (sha: string): Promise<string> => {
    this.started.push(sha);
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    return new Promise<string>((resolve, reject) => {
      const list = this.#pending.get(sha) ?? [];
      list.push({ resolve, reject });
      this.#pending.set(sha, list);
    }).finally(() => this.inFlight--);
  };

  answer(sha: string, text = `text of ${sha}`): void {
    this.#pending.get(sha)!.shift()!.resolve(text);
  }

  fail(sha: string): void {
    this.#pending.get(sha)!.shift()!.reject(new Error(`no ${sha}`));
  }
}

/** Lets settled promises run their handlers. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("BlobReads", () => {
  it("starts planned reads in order, at most the limit at once, and hands each over when asked", async () => {
    const remote = new Remote();
    const blobs = new BlobReads(remote.read);
    blobs.plan(["a", "b", "c", "d", "e", "f"]);
    expect(BLOB_READS_AT_ONCE).toBe(4);
    expect(remote.started).toEqual(["a", "b", "c", "d"]);
    // Answered out of order: each read still gets its own text, and the
    // next planned one starts as a slot frees.
    remote.answer("c");
    await settle();
    expect(remote.started).toEqual(["a", "b", "c", "d", "e"]);
    for (const sha of ["d", "b", "a", "e"]) remote.answer(sha);
    await settle();
    expect(remote.started).toEqual(["a", "b", "c", "d", "e", "f"]);
    remote.answer("f");
    for (const sha of ["a", "b", "c", "d", "e", "f"]) expect(await blobs.read(sha)).toBe(`text of ${sha}`);
    expect(remote.peak).toBe(4);
    blobs.close();
  });

  it("hands a planned read over once: a second read of it is a request of its own, as a reader one by one makes", async () => {
    const remote = new Remote();
    const blobs = new BlobReads(remote.read);
    blobs.plan(["a", "a", "b"]);
    expect(remote.started).toEqual(["a", "a", "b"]);
    remote.answer("a", "first");
    remote.answer("a", "second");
    remote.answer("b");
    expect(await blobs.read("a")).toBe("first");
    expect(await blobs.read("a")).toBe("second");
    const third = blobs.read("a");
    await settle();
    expect(remote.started).toEqual(["a", "a", "b", "a"]);
    remote.answer("a", "third");
    expect(await third).toBe("third");
  });

  it("starts a read asked for ahead of planned ones, and still keeps to the limit", async () => {
    const remote = new Remote();
    const blobs = new BlobReads(remote.read);
    blobs.plan(["a", "b", "c", "d", "e"]);
    const own = blobs.read("x");
    // Asked for a planned read that hasn't started: it goes next too.
    const late = blobs.read("e");
    expect(remote.started).toEqual(["a", "b", "c", "d"]);
    remote.answer("a");
    await settle();
    expect(remote.started).toEqual(["a", "b", "c", "d", "e"]);
    remote.answer("b");
    await settle();
    expect(remote.started).toEqual(["a", "b", "c", "d", "e", "x"]);
    remote.answer("e");
    remote.answer("x");
    expect(await late).toBe("text of e");
    expect(await own).toBe("text of x");
    expect(remote.peak).toBe(4);
  });

  it("starts no planned read after one fails, and the failure reaches the reader when it asks", async () => {
    const remote = new Remote();
    const blobs = new BlobReads(remote.read);
    blobs.plan(["a", "b", "c", "d", "e", "f"]);
    remote.fail("b");
    await settle();
    remote.answer("a");
    remote.answer("c");
    remote.answer("d");
    await settle();
    expect(remote.started).toEqual(["a", "b", "c", "d"]);
    expect(await blobs.read("a")).toBe("text of a");
    await expect(blobs.read("b")).rejects.toThrow("no b");
    // A planned read that never started still starts once asked for.
    const e = blobs.read("e");
    await settle();
    expect(remote.started).toEqual(["a", "b", "c", "d", "e"]);
    remote.answer("e");
    expect(await e).toBe("text of e");
  });

  it("starts nothing more once closed, and a failure no one asks for is not unhandled", async () => {
    const remote = new Remote();
    const blobs = new BlobReads(remote.read, 2);
    blobs.plan(["a", "b", "c"]);
    blobs.close();
    remote.fail("a");
    remote.answer("b");
    await settle();
    expect(remote.started).toEqual(["a", "b"]);
    blobs.plan(["d"]);
    expect(remote.started).toEqual(["a", "b"]);
  });

  it("passes a read that throws at once to the reader as a rejection", async () => {
    const blobs = new BlobReads(() => {
      throw new Error("offline");
    });
    blobs.plan(["a"]);
    await expect(blobs.read("a")).rejects.toThrow("offline");
  });
});
