import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { useSession } from '../api/session';
import { fetchLeaderboard, removeMyLeaderboardEntry } from '../social/api';
import type { LeaderboardRow } from '../social/types';
import { onPublished } from '../social/useSocialStore';
import type { ShareSource } from './ShareMogSheet';

type Props = { onShare: (source: ShareSource) => void; onOpenPost: (postId: string) => void; onOpenLatest: () => void };

export function SharedLeaderboard({ onShare, onOpenPost, onOpenLatest }: Props) {
  const session = useSession();
  const [mode, setMode] = useState<'live' | 'upload'>('live');
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [mine, setMine] = useState<LeaderboardRow | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');

  const load = useCallback(async (next: string | null) => {
    if (!next) setStatus('loading');
    try {
      const page = await fetchLeaderboard(next, mode);
      setRows((previous) => (next ? [...previous, ...page.items.filter((row) => !previous.some((p) => p.entryId === row.entryId))] : page.items));
      setMine(page.viewerEntry);
      setCursor(page.nextCursor);
      setStatus('ready');
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'Could not load the shared leaderboard.');
      setStatus('error');
    }
  }, [mode]);

  useEffect(() => { void load(null); }, [load, session.viewerKey]);
  useEffect(() => onPublished(() => { void load(null); }), [load]);

  const ownActions = (row: LeaderboardRow) => {
    if (!row.isMine || !row.resultId) return null;
    const source: ShareSource = { resultId: row.resultId, displayName: row.displayName, score: row.score, tier: row.tier, captureMode: mode, photoAvailable: false };
    return <div className="row-actions">
      {row.postStatus === 'active' && row.postId && <button type="button" className="text-button" onClick={() => onOpenPost(row.postId!)}>View mog</button>}
      {!row.postStatus && <button type="button" className="text-button strong" onClick={() => onShare(source)}>Share as mog</button>}
      {row.postStatus === 'deleted' && <span className="muted">Mog deleted</span>}
      <button type="button" className="text-button" onClick={async () => {
        if (!window.confirm('Remove your entry from the shared leaderboard? Your scan result and any mog stay.')) return;
        try { await removeMyLeaderboardEntry(mode); void load(null); } catch (error) { setMessage(error instanceof ApiError ? error.message : 'Could not remove.'); }
      }}>Remove from board</button>
    </div>;
  };

  const mineOnPage = rows.some((row) => row.isMine);
  return <div className="shared-board">
    <div className="social-tabs small" role="tablist" aria-label="Scan type">
      <button type="button" role="tab" aria-selected={mode === 'live'} className={mode === 'live' ? 'active' : ''} onClick={() => setMode('live')}>Live scans</button>
      <button type="button" role="tab" aria-selected={mode === 'upload'} className={mode === 'upload' ? 'active' : ''} onClick={() => setMode('upload')}>Photo uploads</button>
    </div>
    {status === 'loading' && <p className="feed-status" role="status">Loading…</p>}
    {status === 'error' && <p className="mog-inline-error" role="alert">{message}</p>}
    {status === 'ready' && rows.length === 0 && <p>No shared scores yet. Save a new scan to be first.</p>}
    {rows.length > 0 && <ol>{rows.map((row) => <li key={row.entryId} className={row.isMine ? 'mine' : ''}>
      <span>#{row.rank} {row.displayName}{row.isMine && <em> · you</em>}</span><b>{row.score} · {row.tier}</b>{ownActions(row)}
    </li>)}</ol>}
    {mine && !mineOnPage && <ol className="my-row"><li className="mine"><span>#{mine.rank} {mine.displayName}<em> · you</em></span><b>{mine.score} · {mine.tier}</b>{ownActions(mine)}</li></ol>}
    {cursor && <button type="button" className="secondary load-more" onClick={() => void load(cursor)}>Load more</button>}
    <button type="button" className="text-button" onClick={onOpenLatest}>Latest mogs →</button>
  </div>;
}
