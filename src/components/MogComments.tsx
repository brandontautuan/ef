import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, newIdempotencyKey } from '../api/client';
import { ensureSession, markSessionLost } from '../api/session';
import { createComment, fetchComments } from '../social/api';
import { codePointLength, hasControlChars, normalizeCaption, relativeTime } from '../social/format';
import { castCommentVote, removeOwnComment, upsertComments, useComment, useCommentMeta } from '../social/useCommentStore';
import { setCommentCount, useViewerEpoch } from '../social/useSocialStore';
import { VoteButtons } from './VoteButtons';

const COMMENT_MAX = 500;

function CommentItem({ id }: { id: string }) {
  const comment = useComment(id);
  const { pending, removed, error } = useCommentMeta(id);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  if (!comment || removed) return null;
  return <li className="mog-comment">
    <div className="mog-comment-head">
      <b>{comment.authorLabel}</b>
      {comment.isPostAuthor && <span className="op-tag" title="Posted this mog">OP</span>}
      <span aria-hidden="true"> · </span>
      <time dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString()}>{relativeTime(comment.createdAt)}</time>
      {comment.isAuthor && <span className="mog-owner-tag">YOU</span>}
    </div>
    <p className="mog-comment-body">{comment.body}</p>
    <div className="mog-comment-foot">
      <VoteButtons compact value={comment.viewerVote} score={comment.mogScore} pending={pending} error={error} groupLabel="Vote on this comment" onVote={(clicked) => void castCommentVote(id, clicked)} />
      {comment.isAuthor && !confirming && <button type="button" className="text-button" onClick={() => setConfirming(true)}>Delete</button>}
    </div>
    {confirming && <div className="mog-confirm" role="alertdialog" aria-label="Delete this comment?">
      <p>Delete this comment? This removes it and its votes.</p>
      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={async () => {
          setBusy(true);
          try { await removeOwnComment(id); } catch (reason) { setNotice(reason instanceof ApiError ? reason.message : 'Could not delete. Try again.'); setBusy(false); setConfirming(false); }
        }}>{busy ? 'Deleting…' : 'Delete'}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>Keep it</button>
      </div>
    </div>}
    {notice && <p className="mog-inline-note" role="status">{notice}</p>}
  </li>;
}

export function MogComments({ postId, count }: { postId: string; count: number }) {
  const epoch = useViewerEpoch();
  const [ids, setIds] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  // Reused after an unknown outcome (lost reply) so a retry can't post twice.
  const keyRef = useRef(newIdempotencyKey());
  const [uncertain, setUncertain] = useState(false);

  const load = useCallback(async (next: string | null) => {
    try {
      const page = await fetchComments(postId, next);
      upsertComments(page.items);
      setIds((previous) => {
        const incoming = page.items.map((item) => item.id);
        return next ? [...previous, ...incoming.filter((id) => !previous.includes(id))] : incoming;
      });
      setCursor(page.nextCursor);
      setCommentCount(postId, page.commentCount);
      setStatus('ready');
    } catch (reason) {
      if (!next) { setStatus('error'); setLoadError(reason instanceof ApiError ? reason.message : 'Could not load comments.'); }
    }
  }, [postId]);

  useEffect(() => { void load(null); }, [load, epoch]);

  const normalized = normalizeCaption(draft);
  const length = codePointLength(normalized);
  const invalid = length === 0 || length > COMMENT_MAX || hasControlChars(normalized);

  const submit = async () => {
    if (posting || invalid) return;
    setPosting(true); setPostError(null);
    try {
      await ensureSession();
      const { comment, commentCount } = await createComment(postId, normalized, keyRef.current);
      upsertComments([comment]);
      setIds((previous) => (previous.includes(comment.id) ? previous : [...previous, comment.id]));
      setCommentCount(postId, commentCount);
      setDraft(''); setUncertain(false);
      keyRef.current = newIdempotencyKey();
    } catch (reason) {
      const apiError = reason instanceof ApiError ? reason : null;
      if (apiError?.transient) {
        setUncertain(true);
        setPostError('Connection problem. Retry to finish posting. It won’t post twice.');
      } else {
        setUncertain(false);
        keyRef.current = newIdempotencyKey();
        if (apiError?.status === 401 && apiError.code === 'session_required') { markSessionLost(); setPostError('Your anonymous session ended. Tap Comment to start a new one.'); }
        else setPostError(apiError?.message ?? 'Could not post your comment.');
      }
    } finally {
      setPosting(false);
    }
  };

  return <section className="mog-comments" aria-labelledby={`comments-${postId}`}>
    <h2 id={`comments-${postId}`}>{count === 1 ? '1 comment' : `${count} comments`}</h2>
    <form className="comment-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="caption-field">
        <span className="visually-hidden">Add a comment</span>
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={2} placeholder="Add a comment…" disabled={posting || uncertain} aria-invalid={length > COMMENT_MAX} />
        <small className={length > COMMENT_MAX ? 'over' : ''}>{length}/{COMMENT_MAX}</small>
      </label>
      {postError && <p className="mog-inline-error" role="alert">{postError}</p>}
      <div className="comment-composer-actions">
        <span className="share-fineprint">Anonymous. Shows your leaderboard name if you’ve set one.</span>
        <button type="submit" className="primary" disabled={posting || invalid}>{posting ? 'Posting…' : uncertain ? 'Retry' : 'Comment'}</button>
      </div>
    </form>
    {status === 'loading' && <p className="feed-status" role="status">Loading comments…</p>}
    {status === 'error' && <div className="feed-status error"><p role="alert">{loadError}</p><button type="button" className="secondary" onClick={() => void load(null)}>Try again</button></div>}
    {status === 'ready' && ids.length === 0 && <p className="feed-status">No comments yet. Say something.</p>}
    {ids.length > 0 && <ol className="mog-comment-list">{ids.map((id) => <CommentItem key={id} id={id} />)}</ol>}
    {cursor && <button type="button" className="secondary load-more" disabled={loadingMore} onClick={async () => { setLoadingMore(true); await load(cursor); setLoadingMore(false); }}>{loadingMore ? 'Loading…' : 'More comments'}</button>}
  </section>;
}
