/** Bounded concurrency runner; lighter than `p-limit` and avoids an extra dep. */
export function pLimit(concurrency: number) {
  // Zero, NaN, or negative would make `active >= concurrency` true on the first dequeue
  // attempt (e.g. 0 >= 0), so work never starts — the job appears stuck forever.
  const cap = Math.max(1, Math.floor(Number(concurrency)) || 1);
  let active = 0;
  const queue: Array<() => void> = [];

  const next = (): void => {
    if (active >= cap) return;
    const fn = queue.shift();
    if (!fn) return;
    active += 1;
    fn();
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      });
      next();
    });
  };
}

/** Compute set-difference of two arrays of strings. Returns elements in `a` that are not in `b`. */
export function setDiff(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return a.filter((x) => !set.has(x));
}

/** Stable hash of a record's vector + metadata. Used by the verification step. */
export function recordHash(r: {
  values?: number[];
  sparseValues?: { indices: number[]; values: number[] };
  metadata?: Record<string, unknown>;
}): string {
  const norm = {
    v: r.values ? r.values.map((x) => Math.round(x * 1e6) / 1e6) : null,
    sv: r.sparseValues ?? null,
    m: r.metadata ?? null,
  };
  return cyrb53(JSON.stringify(norm)).toString(16);
}

// 53-bit cyrb53; fast non-cryptographic hash (not used for security).
function cyrb53(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
