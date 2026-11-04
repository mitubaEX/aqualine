import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

type Category = 'bug' | 'idea' | 'other';

export default function Feedback() {
  const id = useId();
  const [category, setCategory] = useState<Category>('idea');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const pending = useRef(false);
  const attempt = useRef<{ category: Category; text: string; key: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);
  const length = Array.from(text.trim()).length;

  function changed() {
    attempt.current = null;
    setError('');
    setSuccess(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    const message = text.trim();
    if (length < 1 || length > 500) {
      setError('ご意見は1〜500文字で入力してください。');
      return;
    }
    pending.current = true;
    setBusy(true);
    setError('');
    setSuccess(false);
    const abort = new AbortController();
    controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), 15000);
    try {
      if (!attempt.current || attempt.current.text !== message || attempt.current.category !== category) {
        attempt.current = { category, text: message, key: crypto.randomUUID() };
      }
      const response = await fetch('/api/feedback', {
        method: 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' },
        signal: abort.signal,
        body: JSON.stringify({ category, text: message, idempotencyKey: attempt.current.key }),
      });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
          ? data.error
          : response.status === 429
          ? '送信が混み合っています。少し時間をおいて、もう一度お試しください。'
          : '送信を確認できませんでした。内容を残しています。通信を確認して、もう一度お試しください。');
      }
      if (!data || typeof data !== 'object' || !('id' in data) || typeof data.id !== 'string' || !data.id.trim()) {
        throw new Error('送信を確認できませんでした。内容を残しています。もう一度お試しください。');
      }
      if (mounted.current) {
        setSuccess(true);
        setText('');
        attempt.current = null;
      }
    } catch (cause) {
      if (mounted.current) setError(abort.signal.aborted
        ? '通信がタイムアウトしました。送信できたか確認できないため、内容を残しています。再送信できます。'
        : cause instanceof TypeError
          ? '通信できませんでした。内容を残しています。接続を確認して、もう一度お試しください。'
          : cause instanceof Error ? cause.message : '送信を確認できませんでした。もう一度お試しください。');
    } finally {
      clearTimeout(timeout);
      if (controller.current === abort) controller.current = null;
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <details className="feedback">
    <summary>ご意見・不具合を送る</summary>
    <form onSubmit={event => void submit(event)} aria-label="運営へのフィードバック" aria-busy={busy}>
      <p className="feedback-intro">使ってみて感じたことを、運営に教えてください。</p>
      <p id={`${id}-privacy`} className="feedback-notice">運営だけに届き、広場には公開されません。内容は30日間保存します。氏名・連絡先などの個人情報は書かないでください。緊急の連絡には使えません。個別の返信はお約束できません。</p>
      <p className="feedback-notice">運転中・歩行中は操作しないでください。送信に位置情報や参加チケットは使いません。</p>
      <label htmlFor={`${id}-category`}>種類</label>
      <select id={`${id}-category`} value={category} disabled={busy} onChange={event => { changed(); setCategory(event.target.value as Category); }}>
        <option value="idea">アイデア・ご要望</option><option value="bug">不具合</option><option value="other">その他</option>
      </select>
      <label htmlFor={`${id}-text`}>ご意見（1〜500文字）</label>
      <textarea id={`${id}-text`} value={text} disabled={busy} rows={4} required aria-invalid={length > 500} aria-describedby={`${id}-privacy ${id}-count`} onChange={event => { changed(); setText(event.target.value); }} placeholder="よかったこと、困ったこと、ほしい機能など" />
      <div className="feedback-actions"><span id={`${id}-count`} className={length > 500 ? 'feedback-over-limit' : ''}>{length} / 500文字</span><button type="submit" className="primary" disabled={busy || length < 1 || length > 500}>{busy ? '送信中…' : '運営に送る'}</button></div>
      <p className="feedback-status" role="status" aria-live="polite">{success ? 'ご意見を受け付けました。ありがとうございます。' : busy ? 'ご意見を送信しています。' : ''}</p>
      {error && <p className="feedback-error" role="alert">{error}</p>}
    </form>
  </details>;
}
