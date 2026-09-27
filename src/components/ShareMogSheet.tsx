import { useRef, useState } from 'react';
import { ApiError, newIdempotencyKey } from '../api/client';
import { ensureSession, markSessionLost } from '../api/session';
import { publishPost } from '../social/api';
import { CAPTION_MAX, codePointLength, hasControlChars, normalizeCaption } from '../social/format';
import type { MogPost, ShareableResult } from '../social/types';
import { notifyPublished } from '../social/useSocialStore';

export type ShareSource = Pick<ShareableResult, 'resultId' | 'displayName' | 'score' | 'tier' | 'captureMode' | 'photoAvailable'>;
type Props = { source: ShareSource; onClose: () => void; onPosted: (post: MogPost) => void; onOpenPost: (postId: string) => void };

export function ShareMogSheet({ source, onClose, onPosted, onOpenPost }: Props) {
  const [caption, setCaption] = useState('');
  const [includePhoto, setIncludePhoto] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingPostId, setExistingPostId] = useState<string | null>(null);
  const [photoExpired, setPhotoExpired] = useState(false);
  // One key per intended post. It is reused for retries after an unknown outcome
  // (lost reply), so a retry returns the same post instead of creating another.
  const keyRef = useRef(newIdempotencyKey());
  const [uncertain, setUncertain] = useState(false);

  const normalized = normalizeCaption(caption);
  const length = codePointLength(normalized);
  const invalid = length > CAPTION_MAX || hasControlChars(normalized);

  const submit = async (withPhoto = includePhoto) => {
    if (pending || invalid) return;
    setPending(true); setError(null); setExistingPostId(null);
    try {
      await ensureSession();
      const { post } = await publishPost({ resultId: source.resultId, caption: normalized || null, includePhoto: withPhoto }, keyRef.current);
      notifyPublished(post);
      onPosted(post);
    } catch (reason) {
      const apiError = reason instanceof ApiError ? reason : null;
      if (apiError?.transient) {
        setUncertain(true); // outcome unknown: only retry with the same key and payload
        setError('Connection problem. Retry to finish posting. It won’t post twice.');
      } else {
        setUncertain(false);
        keyRef.current = newIdempotencyKey(); // definitive failure: nothing was created
        if (apiError?.code === 'result_already_posted') {
          setExistingPostId(typeof apiError.details?.postId === 'string' ? apiError.details.postId : null);
          setError('This result is already posted.');
        } else if (apiError?.code === 'source_media_expired') {
          setPhotoExpired(true);
          setError(apiError.message);
        } else if (apiError?.status === 401 && apiError.code === 'session_required') {
          markSessionLost();
          setError('Your anonymous session ended. Tap Post mog to start a new one. Results from the old session can’t be shared from here.');
        } else if (apiError?.status === 429) {
          setError(apiError.message);
        } else {
          setError(apiError?.message ?? 'Could not post. Try again.');
        }
      }
    } finally {
      setPending(false);
    }
  };

  return <div className="modal" role="dialog" aria-modal="true" aria-labelledby="share-mog-title">
    <div className="modal-card share-sheet">
      <p className="eyebrow">ANONYMOUS · NO LOGIN</p>
      <h2 id="share-mog-title">Share as mog</h2>
      <div className="share-preview" aria-label="Result preview">
        <span className="share-author">{source.displayName || 'Anonymous'}</span>
        <div className="mog-score"><span>{source.score}</span><small>/100</small></div>
        <span className="tier"><span className="tier-mark" />{source.tier}</span>
      </div>
      <label className="caption-field">
        <span>Caption <small>(optional)</small></span>
        <textarea value={caption} onChange={(event) => setCaption(event.target.value)} rows={3} placeholder="Say something about it…" disabled={pending || uncertain} aria-invalid={invalid} />
        <small className={length > CAPTION_MAX ? 'over' : ''}>{length}/{CAPTION_MAX}</small>
      </label>
      {source.photoAvailable && !photoExpired && <label className="toggle"><input type="checkbox" checked={includePhoto} disabled={pending || uncertain} onChange={(event) => setIncludePhoto(event.target.checked)} /> Include my scan photo</label>}
      <p className="share-fineprint">Posts show your leaderboard name, score, and tier in Latest Mogs with a public link. Only this browser can delete it.</p>
      {error && <p className="mog-inline-error" role="alert">{error}</p>}
      <div className="actions">
        {existingPostId
          ? <button type="button" className="primary" onClick={() => onOpenPost(existingPostId)}>Open existing mog</button>
          : photoExpired && includePhoto
            ? <button type="button" className="primary" disabled={pending} onClick={() => { setIncludePhoto(false); void submit(false); }}>Post without photo</button>
            : <button type="button" className="primary" disabled={pending || invalid} onClick={() => void submit()}>{pending ? 'Posting…' : uncertain ? 'Retry posting' : 'Post mog'} <span aria-hidden="true">↗</span></button>}
        <button type="button" className="secondary" disabled={pending} onClick={onClose}>Cancel</button>
      </div>
    </div>
  </div>;
}
