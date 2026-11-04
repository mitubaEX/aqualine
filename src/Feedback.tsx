export const FEEDBACK_FORM_URL='https://docs.google.com/forms/d/e/1FAIpQLSeIQZRPsiWgp8Za9JuBKBd2PZrdGhycglW76tJvMKEjOBGwZA/viewform';
export default function Feedback(){
 return <section className="feedback feedback-link" aria-label="フィードバック"><h2>ご意見・不具合</h2><p>使ってみて感じたことを、運営に教えてください。Googleフォームが新しいタブで開きます。</p><a className="primary" href={FEEDBACK_FORM_URL} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">ご意見・不具合を送る ↗</a><p>参加・位置確認は不要です。回答は広場に公開されません。氏名・連絡先などの個人情報は書かないでください。緊急連絡には使えず、個別の返信はお約束できません。</p><p>回答はGoogleフォームで管理します。運転中・歩行中は操作しないでください。</p></section>;
}
