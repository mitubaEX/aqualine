export const TICKET_MS = 20 * 60_000;
export const VISIBLE_MS = 60 * 60_000;
export const DELETE_MS = 24 * 60 * 60_000;
export const QUARANTINE_MS = 30 * DELETE_MS;
export type Direction = 'tokyo' | 'kisarazu';
export type Reaction = 'wave' | 'thanks' | 'same';
export interface Location { lat: number; lng: number; accuracy: number }
export interface Session { id: string; name: string; direction: Direction; expiresAt: number; posts: number[] }
export interface Post { id: string; authorId: string; name: string; direction: Direction; text: string; parentId?: string; createdAt: number; reactions: Record<Reaction, string[]>; reportedAt?: number }
// MVP approximation, NOT a surveyed highway boundary. Must be field-validated before launch.
// A narrow line follows the tunnel and bridge, not a broad bay-wide bounding box.
export const ROAD = [[35.5199,139.8159],[35.4924,139.8506],[35.4645,139.8753],[35.4468,139.9179]] as const;
export function locationStatus(value: unknown): 'inside' | 'outside' | 'unknown' {
  if (!value || typeof value !== 'object') return 'unknown';
  const {lat,lng,accuracy} = value as Location;
  if (![lat,lng,accuracy].every(Number.isFinite) || Math.abs(lat)>90 || Math.abs(lng)>180 || accuracy<0 || accuracy>80) return 'unknown';
  const scaleX = 111_320 * Math.cos(lat * Math.PI / 180), scaleY = 111_320;
  let distance = Infinity;
  for(let i=1;i<ROAD.length;i++) {
    const a=ROAD[i-1],b=ROAD[i];
    const ax=(a[1]-lng)*scaleX, ay=(a[0]-lat)*scaleY, bx=(b[1]-lng)*scaleX, by=(b[0]-lat)*scaleY;
    const dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy)));
    distance=Math.min(distance,Math.hypot(ax+t*dx,ay+t*dy));
  }
  const umihotaru=Math.hypot((lng-139.8753)*scaleX,(lat-35.4645)*scaleY);
  // Require uncertainty circle wholly in entry corridor; boundary ambiguity never renews.
  if(distance+accuracy<=100 || umihotaru+accuracy<=190) return 'inside';
  if(distance-accuracy>150 && umihotaru-accuracy>240) return 'outside';
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
