import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { fetchPost } from '../social/api';
import type { AppRoute } from '../social/useAppRoute';
import { markDeleted, upsertPosts, usePostMeta, useViewerEpoch } from '../social/useSocialStore';
import { MogPostCard } from './MogPostCard';

type Props = { id: string; onNavigate: (route: AppRoute) => void };

export function MogPostDetail({ id, onNavigate }: Props) {
  const epoch = useViewerEpoch();
  const { deleted } = usePostMeta(id);
  const [status, setStatus] = useState<'loading' | 'ready' | 'deleted' | 'missing' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);

  // Returning to the tab refreshes counts, viewer state, and deletion.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') setRefreshToken((value) => value + 1); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); };
  }, []);

  useEffect(() => {
    let active = true;
    fetchPost(id)
      .then((post) => { if (!active) return; upsertPosts([post]); setStatus('ready'); })
      .catch((error) => {
        if (!active) return;
        if (error instanceof ApiError && error.status === 410) { markDeleted(id); setStatus('deleted'); }
        else if (error instanceof ApiError && error.status === 404) setStatus('missing');
        else { setStatus('error'); setMessage(error instanceof ApiError ? error.message : 'Could not load this mog.'); }
      });
    return () => { active = false; };
  }, [id, epoch, refreshToken]);

  const back = <button type="button" className="text-button" onClick={() => onNavigate({ name: 'latest' })}>← Latest mogs</button>;
  if (deleted || status === 'deleted') return <div className="mog-detail">{back}<div className="feed-status"><h2>This mog was deleted.</h2><p>Its author removed the post and its votes.</p></div></div>;
  if (status === 'missing') return <div className="mog-detail">{back}<div className="feed-status"><h2>Mog not found.</h2><p>Check the link, or browse the latest mogs.</p></div></div>;
  if (status === 'error') return <div className="mog-detail">{back}<div className="feed-status error"><p role="alert">{message}</p></div></div>;
  if (status === 'loading') return <div className="mog-detail">{back}<p className="feed-status" role="status">Loading mog…</p></div>;
  return <div className="mog-detail">{back}<MogPostCard id={id} onNavigate={onNavigate} detail /></div>;
}
