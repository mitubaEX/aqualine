import { CONGESTION_LEVELS, CONGESTION_WINDOW_MS, CONGESTION_MIN_SAMPLES, type CongestionLevel, type CongestionSummary } from '../src/congestion';
import { type Post, visible } from './domain';
export function validCongestion(value: unknown): CongestionLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !CONGESTION_LEVELS.includes(value as CongestionLevel)) throw new Error('混雑状況は決められた4段階から選んでください');
  return value as CongestionLevel;
}
// Derive only from live posts. Deletion/quarantine takes effect immediately; no extra identifying store.
export function congestionSummary(posts: Post[], now: number): CongestionSummary {
  return { generatedAt: now, windowStart: now - CONGESTION_WINDOW_MS, windowMinutes: 15, minimumSamples: CONGESTION_MIN_SAMPLES,
    directions: (['tokyo', 'kisarazu'] as const).map(direction => {
      const latest = new Map<string, Post>();
      for (const p of posts) if (p.direction === direction && p.congestion && CONGESTION_LEVELS.includes(p.congestion) && visible(p, now) && p.createdAt <= now && now - p.createdAt < CONGESTION_WINDOW_MS) {
        if (!latest.has(p.authorId) || latest.get(p.authorId)!.createdAt <= p.createdAt) latest.set(p.authorId, p);
      }
      const counts: Record<CongestionLevel, number> = { jammed: 0, busy: 0, moving: 0, clear: 0 };
      for (const p of latest.values()) counts[p.congestion!]++;
      const sampleSize = latest.size, enough = sampleSize >= CONGESTION_MIN_SAMPLES;
      const max = Math.max(...Object.values(counts));
      return { direction, sampleSize, counts: enough ? counts : null, leading: enough ? CONGESTION_LEVELS.filter(level => counts[level] === max) : [] };
    }) };
}
