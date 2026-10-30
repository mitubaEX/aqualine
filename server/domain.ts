export const TICKET_MS = 20 * 60_000;
export const VISIBLE_MS = 60 * 60_000;
export const DELETE_MS = 24 * 60 * 60_000;
export const QUARANTINE_MS = 30 * DELETE_MS;
// Geofence policy (metres). Tune these independently of the surveyed/approximated shape.
export const ENTRY_DISTANCE_METRES = 100;
export const MAX_LOCATION_ACCURACY_METRES = 80;
export const EXIT_DISTANCE_METRES = 150;
export const UMIHOTARU_ENTRY_RADIUS_METRES = 190;
export const UMIHOTARU_EXIT_RADIUS_METRES = 240;
export type Direction = 'tokyo' | 'kisarazu';
export type Reaction = 'wave' | 'thanks' | 'same';
export interface Location { lat: number; lng: number; accuracy: number }
export interface Session { id: string; name: string; direction: Direction; expiresAt: number; posts: number[] }
export interface Post { id: string; authorId: string; name: string; direction: Direction; text: string; parentId?: string; createdAt: number; reactions: Record<Reaction, string[]>; reportedAt?: number }
// MVP approximation, NOT a surveyed highway boundary. Must be field-validated before launch.
// A narrow line follows the tunnel and bridge, not a broad bay-wide bounding box.
// Bridge: GSI experimental vector road data, edited by AquaLine. See docs/geofence-source.md.
export const ROAD = [[35.5199,139.8159],[35.4924,139.8506],[35.4645,139.8753],[35.463877,139.8749954],[35.4631998,139.8759985],[35.4616924,139.8782891],[35.4600189,139.8807567],[35.4469489,139.8999667],[35.4412544,139.9083406],[35.43948,139.9109423],[35.4387457,139.9121171],[35.4381164,139.9132866],[35.4375132,139.9146277],[35.4367964,139.9163604],[35.4365604,139.9169344]] as const;
export function locationStatus(value: unknown): 'inside' | 'outside' | 'unknown' {
  if (!value || typeof value !== 'object') return 'unknown';
  const {lat,lng,accuracy} = value as Location;
  if (![lat,lng,accuracy].every(Number.isFinite) || Math.abs(lat)>90 || Math.abs(lng)>180 || accuracy<0 || accuracy>MAX_LOCATION_ACCURACY_METRES) return 'unknown';
  const scaleX = 111_320 * Math.cos(lat * Math.PI / 180), scaleY = 111_320;
  let distance = Infinity;
  for(let i=1;i<ROAD.length;i++) {
    const a=ROAD[i-1],b=ROAD[i];
    const ax=(a[1]-lng)*scaleX, ay=(a[0]-lat)*scaleY, bx=(b[1]-lng)*scaleX, by=(b[0]-lat)*scaleY;
    const dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy)));
    distance=Math.min(distance,Math.hypot(ax+t*dx,ay+t*dy));
  }
  const umihotaru=Math.hypot((lng-139.8753)*scaleX,(lat-35.4645)*scaleY);
  // Road entry uses distance independently of accuracy; poor accuracy was rejected above.
  // Preserve the PA uncertainty-circle rule and conservative exit hysteresis.
  if(distance<=ENTRY_DISTANCE_METRES || umihotaru+accuracy<=UMIHOTARU_ENTRY_RADIUS_METRES) return 'inside';
  if(distance-accuracy>EXIT_DISTANCE_METRES && umihotaru-accuracy>UMIHOTARU_EXIT_RADIUS_METRES) return 'outside';
  return 'unknown';
}
export function validText(value: unknown): string {
  if(typeof value!=='string') throw new Error('本文を入力してください');
  const text=value.trim();
  if(!text || [...text].length>140) throw new Error('本文は1〜140文字で入力してください');
  if(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b)/iu.test(text)) throw new Error('リンクは投稿できません');
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw new Error('使用できない文字が含まれています');
  return text;
}
export function postingAllowed(session: Session, now: number) {
  const recent=session.posts.filter(t=>now-t<600_000);
  return recent.length<10 && (!recent.length || now-recent[recent.length-1]>=10_000);
}
export function visible(post: Post, now: number) { return !post.reportedAt && now-post.createdAt<VISIBLE_MS; }
export function retained(post: Post, now: number) { return post.reportedAt ? now-post.reportedAt<QUARANTINE_MS : now-post.createdAt<DELETE_MS; }
