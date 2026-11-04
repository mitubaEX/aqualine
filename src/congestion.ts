export const CONGESTION_LEVELS = ['jammed', 'busy', 'moving', 'clear'] as const;
export type CongestionLevel = typeof CONGESTION_LEVELS[number];
export const CONGESTION_LABELS: Record<CongestionLevel, string> = { jammed: '激混み', busy: '混み', moving: '動いてる', clear: '空いてる' };
export const CONGESTION_WINDOW_MS = 15 * 60_000;
export const CONGESTION_MIN_SAMPLES = 3;
export interface CongestionSummary {
  generatedAt: number; windowStart: number; windowMinutes: number; minimumSamples: number;
  directions: { direction: 'tokyo' | 'kisarazu'; sampleSize: number; counts: Record<CongestionLevel, number> | null; leading: CongestionLevel[] }[];
}
