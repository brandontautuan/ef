import { useState } from 'react';
import { ApiError } from '../api/client';
import { relativeTime } from '../social/format';
import { shareUrl, type AppRoute } from '../social/useAppRoute';
import { removeOwnPost, usePost, usePostMeta } from '../social/useSocialStore';
import { MogVoteControls } from './MogVoteControls';

type Props = { id: string; onNavigate: (route: AppRoute) => void; detail?: boolean };

export function MogPostCard({ id, onNavigate, detail = false }: Props) {
  const post = usePost(id);
  const { deleted } = usePostMeta(id);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  if (!post || deleted) return null;
  const route: AppRoute = { name: 'post', id };

  const share = async () => {
    const url = shareUrl(route);
    try {
      if (navigator.share) { await navigator.share({ title: 'MOG / SCAN', text: `${post.result.score}/100 · ${post.result.tier}`, url }); return; }
      await navigator.clipboard.writeText(url);
      setNotice('Link copied.');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setNotice(url);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await removeOwnPost(id);
      if (detail) onNavigate({ name: 'latest' });
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : 'Could not delete. Try again.');
      setDeleting(false);
      setConfirming(false);
    }
  };

  const title = <><b>{post.authorLabel}</b><span aria-hidden="true"> · </span><time dateTime={post.createdAt} title={new Date(post.createdAt).toLocaleString()}>{relativeTime(post.createdAt)}</time></>;
  return <article className={`mog-card${detail ? ' detail' : ''}`} aria-label={`Mog by ${post.authorLabel}`}>
    <header className="mog-card-head">
      {detail ? <p>{title}</p> : <a href={`#/mogs/${id}`} onClick={(event) => { event.preventDefault(); onNavigate(route); }}>{title}</a>}
      {post.isOwner && <span className="mog-owner-tag">YOUR MOG</span>}
    </header>
    {post.caption && <p className="mog-caption">{post.caption}</p>}
    <div className="mog-result">
      {post.mediaUrl && <img src={post.mediaUrl} alt={`${post.authorLabel}'s scan photo`} loading="lazy" />}
      <div className="mog-score" aria-label={`Scan score ${post.result.score} out of 100`}><span>{post.result.score}</span><small>/100</small></div>
      <div className="mog-result-meta"><span className="tier"><span className="tier-mark" />{post.result.tier}</span><small>{post.result.captureMode === 'upload' ? 'PHOTO UPLOAD' : 'LIVE SCAN'}</small></div>
    </div>
    <footer className="mog-card-foot">
      <MogVoteControls post={post} />
      <div className="mog-card-actions">
        <button type="button" className="text-button" onClick={() => void share()}>Share</button>
        {post.isOwner && !confirming && <button type="button" className="text-button" onClick={() => setConfirming(true)}>Delete</button>}
      </div>
    </footer>
    {confirming && <div className="mog-confirm" role="alertdialog" aria-label="Delete this mog?">
      <p>Delete this mog? This removes the post and its votes.</p>
      <div className="actions"><button type="button" className="primary" disabled={deleting} onClick={() => void remove()}>{deleting ? 'Deleting…' : 'Delete'}</button><button type="button" className="secondary" disabled={deleting} onClick={() => setConfirming(false)}>Keep it</button></div>
    </div>}
    {notice && <p className="mog-inline-note" role="status">{notice}</p>}
  </article>;
}
