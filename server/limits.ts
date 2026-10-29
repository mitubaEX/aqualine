// Deliberately small, hard bounds for the first deployment. No paid service required.
export const LIMITS = {
  sessions: 64, posts: 128, sockets: 64, socketsPerTicket: 2,
  snapshotBytes: 96 * 1024, networkBuckets: 100,
  admissionsPerWindow: 60, postsPerWindow: 120,
  reports:128, reportBytes:96*1024, reportThreshold:3,
  pendingRequests:32, globalRequestsPerMinute:3000,
  ticketReads:30, ticketMutations:20, ticketRenewals:6, ticketConnections:6, ticketReports:3,
  windowMs: 10 * 60_000, saltEpochMs: 20 * 60_000,
  reactionsPerPost: 64,
} as const;
export interface RateBucket { admissions: number[]; posts: number[] }
export interface RateState {
  salts: { id: string; value: string; createdAt: number }[];
  buckets: [string, RateBucket][];
}
export function cleanRates(state: RateState, now: number) {
  state.salts = state.salts.filter(s => now - s.createdAt < LIMITS.saltEpochMs + LIMITS.windowMs);
  const ids = new Set(state.salts.map(s => s.id));
  state.buckets = state.buckets.map(([k, b]) => [k, {
    admissions: b.admissions.filter(t => now - t < LIMITS.windowMs),
    posts: b.posts.filter(t => now - t < LIMITS.windowMs),
  }] as [string, RateBucket]).filter(([k, b]) => ids.has(k.split(':')[0]) && (b.admissions.length > 0 || b.posts.length > 0));
}
// An epoch uses an independent random salt. Raw IPs and resulting keys are never logged.
export async function networkKeys(state: RateState, address: string, now: number) {
  cleanRates(state, now);
  if (!state.salts.some(s => now - s.createdAt < LIMITS.saltEpochMs)) {
    state.salts.push({ id: crypto.randomUUID(), value: crypto.randomUUID(), createdAt: now });
  }
  return Promise.all(state.salts.map(async salt => {
    const bytes = new TextEncoder().encode(salt.value + ':' + address);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return salt.id + ':' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }));
}
