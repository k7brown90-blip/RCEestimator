import { describe, expect, it } from "vitest";
import { keyedMutexSize, withKeyedMutex } from "../src/lib/keyedMutex";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("withKeyedMutex", () => {
  it("runs callers with the same key one at a time, in arrival order", async () => {
    const log: string[] = [];
    let running = 0;
    let peak = 0;
    const job = (name: string, ticks: number) => withKeyedMutex("k", async () => {
      running += 1;
      peak = Math.max(peak, running);
      log.push(`start ${name}`);
      for (let i = 0; i < ticks; i++) await tick();
      log.push(`end ${name}`);
      running -= 1;
      return name;
    });
    const out = await Promise.all([job("a", 5), job("b", 1), job("c", 3)]);
    expect(out).toEqual(["a", "b", "c"]);
    expect(peak).toBe(1);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("runs different keys in parallel", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    const a = withKeyedMutex("one", async () => { started.push("one"); await gate; });
    const b = withKeyedMutex("two", async () => { started.push("two"); await gate; });
    await tick();
    await tick();
    expect(started.sort()).toEqual(["one", "two"]);
    release();
    await Promise.all([a, b]);
  });

  it("a holder that throws reaches only its own caller and does not block the next", async () => {
    const boom = withKeyedMutex("k", async () => { throw new Error("boom"); });
    const next = withKeyedMutex("k", async () => "ok");
    await expect(boom).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
    await expect(withKeyedMutex("k", async () => "again")).resolves.toBe("again");
  });

  it("empties its map when the chain drains, so it cannot grow without bound", async () => {
    expect(keyedMutexSize()).toBe(0);
    await Promise.all(Array.from({ length: 50 }, (_, i) => withKeyedMutex(`key-${i % 5}`, async () => { await tick(); })));
    expect(keyedMutexSize()).toBe(0);
    await withKeyedMutex("x", async () => { throw new Error("late"); }).catch(() => undefined);
    expect(keyedMutexSize()).toBe(0);
  });
});
