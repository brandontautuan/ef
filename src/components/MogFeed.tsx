import type { ReactNode } from 'react';
import { useSession } from '../api/session';
import type { FeedKind } from '../social/types';
import type { AppRoute } from '../social/useAppRoute';
import { useFeed } from '../social/useFeed';
import { MogPostCard } from './MogPostCard';

type Props = {
  kind: FeedKind;
  onNavigate: (route: AppRoute) => void;
  preview?: boolean;
  paused?: boolean;
  empty?: ReactNode;
};

export function MogFeed({ kind, onNavigate, preview = false, paused = false, empty }: Props) {
  const feed = useFeed(kind, { poll: kind === 'latest', paused, maxItems: preview ? 4 : undefined });
  const session = useSession();
  return <div className={`mog-feed${preview ? ' preview' : ''}`}>
    {feed.newCount > 0 && <button type="button" className="new-mogs" onClick={() => { feed.reload(); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
      {feed.newCount}{feed.newCount >= 99 ? '+' : ''} new {feed.newCount === 1 ? 'mog' : 'mogs'} ↑
    </button>}
    {feed.status === 'loading' && <p className="feed-status" role="status">Loading mogs…</p>}
    {feed.status === 'error' && <div className="feed-status error"><p role="alert">{feed.error}</p><button type="button" className="secondary" onClick={feed.reload}>Try again</button></div>}
    {feed.status === 'needs-session' && <div className="feed-status"><p>{session.status === 'blocked' ? 'Cookies are blocked, so this browser has no anonymous identity. Allow cookies to post and vote.' : 'Nothing here yet. Your mogs and votes are tied to this browser; post or vote and they show up here.'}</p></div>}
    {feed.status === 'ready' && feed.ids.length === 0 && (empty ?? <p className="feed-status">No mogs yet. Scan, save to the shared leaderboard, and post the first one.</p>)}
    {feed.ids.length > 0 && <ol className="mog-list">{feed.ids.map((id) => <li key={id}><MogPostCard id={id} onNavigate={onNavigate} /></li>)}</ol>}
    {!preview && feed.hasMore && feed.status === 'ready' && <button type="button" className="secondary load-more" disabled={feed.loadingMore} onClick={() => void feed.loadMore()}>{feed.loadingMore ? 'Loading…' : 'Load more'}</button>}
    {preview && feed.status === 'ready' && feed.ids.length > 0 && <button type="button" className="secondary load-more" onClick={() => onNavigate({ name: 'latest' })}>See all mogs <span aria-hidden="true">↗</span></button>}
  </div>;
}
