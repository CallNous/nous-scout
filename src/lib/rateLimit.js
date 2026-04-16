// Simple sleep-based rate limiter. One instance per API.
// Not a true token bucket — just "at least N ms between calls" — which is
// enough for Places and Claude at the volumes we care about.

export function createLimiter(minIntervalMs) {
  let last = 0;
  return async function limit() {
    const now = Date.now();
    const wait = last + minIntervalMs - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
