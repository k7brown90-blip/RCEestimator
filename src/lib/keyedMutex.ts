/**
 * An in-process, per-key async mutex: callers with the same key run one at a time, in arrival order; callers with
 * different keys run in parallel. A waiter holds nothing but a pending promise, so it costs no database connection
 * while it waits (the reason this exists: agentApi/hubDoor.ts serialises posts to one thread here instead of
 * parking every waiter in a transaction on a Postgres advisory lock).
 *
 * One process only, like the in-memory limiter in agentApi/gate.ts. With more than one replica the database lock
 * is still what keeps the count right; this only stops a burst from using up the connection pool while it waits.
 *
 * An entry is deleted when its chain drains, so the map never grows past the keys that are busy right now. A holder
 * that throws (or rejects) releases the key to the next waiter and its error reaches only its own caller.
 */
const tails = new Map<string, Promise<void>>();

export async function withKeyedMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  // The next waiter chains on this one; `mine` never rejects, so a throwing holder cannot wedge the chain.
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    // Nobody queued behind us: drop the entry so the map empties.
    if (tails.get(key) === tail) tails.delete(key);
  }
}

/** How many keys are held or waited on right now. For tests. */
export const keyedMutexSize = (): number => tails.size;
