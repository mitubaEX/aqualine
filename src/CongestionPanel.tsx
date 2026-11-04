import { useEffect, useState } from 'react';
import { CONGESTION_LABELS, CONGESTION_LEVELS, type CongestionSummary } from './congestion';
import './congestion.css';
export default function Congestion() {
  const [summary, setSummary] = useState<CongestionSummary | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let stopped = false, loading = false;
    let controller: AbortController | undefined;
    async function refresh() {
      if (loading) return; loading = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 15000);
      try {
        const response = await fetch('/api/congestion', { signal: controller.signal });
        if (!response.ok) throw new Error();
        const data = await response.json() as CongestionSummary;
        if (!stopped) { setSummary(data); setError(false); }
      } catch { if (!stopped) setError(true); }
      finally { clearTimeout(timeout); loading = false; }
    }
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 60000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; controller?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [retry]);
  return <section className="congestion-panel" aria-label="みんなの混雑状況"><h2>みんなの混雑状況</h2><p>エリア外からも見られます。直近15分・参加者ごとの最新の回答を集計。</p>
    {error ? <p role="status">混雑状況を更新できません。古い情報は表示していません。<button type="button" onClick={() => setRetry(n => n + 1)}>再試行</button></p> : !summary ? <p role="status">集計を確認中…</p> : <>
      <p>集計時刻：{new Date(summary.generatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}（日本時間）</p>
      <div className="congestion-directions">{summary.directions.map(d => <div key={d.direction}><h3>{d.direction === 'tokyo' ? '東京方面' : '木更津方面'}</h3><strong>{!d.counts ? '回答不足・判定できません' : d.leading.length === 1 ? `${CONGESTION_LABELS[d.leading[0]]} が最多` : '回答が分かれています'}</strong><p>回答 {d.sampleSize} 件（参加券単位）</p>{d.counts ? <ul>{CONGESTION_LEVELS.map(level => <li key={level}>{CONGESTION_LABELS[level]} <b>{d.counts![level]}件</b>（{Math.round(d.counts![level] / d.sampleSize * 100)}%）</li>)}</ul> : <p>3件以上で内訳を表示します。回答なしは「空いてる」を意味しません。</p>}</div>)}</div>
    </>}
    <small>同乗者による任意の体感報告です。道路全体の実測値・公式交通情報ではありません。参加券の再取得による重複は除けません。現在地が未確認の有効な参加券からの報告も含みます。運転中は操作しないでください。</small>
  </section>;
}
