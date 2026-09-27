// Snapshot keyset pagination, load-more, the "N new mogs" prompt, and
// visible-card refresh on focus. New posts never shift loaded pages: page one
// fixes a snapshot sequence, and newer posts only show up as a banner count.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { refreshSession, useSession } from '../api/session';
import { fetchFeed, fetchHead } from './api';
import type { FeedKind } from './types';
import { isDeleted, isVotePending, onPublished, peekPost, refreshPostStates, upsertPosts, useStoreVersion, useViewerEpoch } from './useSocialStore';

const POLL_MS = 15_000;
const MAX_BACKOFF_MS = 120_000;
const NEAR_TOP_PX = 600;

type FeedOptions = { pageSize?: number; poll?: boolean; paused?: boolean; maxItems?: number };
type FeedStatus = 'loading' | 'ready' | 'error' | 'needs-session';

export function useFeed(kind: FeedKind, { pageSize = 20, poll = false, paused = false, maxItems }: FeedOptions = {}) {
  const session = useSession();
  const epoch = useViewerEpoch();
  const storeVersion = useStoreVersion(); // re-render when cached posts change (deletions, vote membership)
  const [ids, setIds] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<number | null>(null);
  const [status, setStatus] = useState<FeedStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const generation = useRef(0);
  const idsRef = useRef<string[]>([]);
  idsRef.current = ids;

  const needsSession = kind !== 'latest';
  const sessionReady = session.status !== 'unknown';
  const sessionActive = session.status === 'active';

  // First page (and full reload on identity change or explicit refresh).
  useEffect(() => {
    if (!sessionReady) return;
    if (needsSession && !sessionActive) { setIds([]); setCursor(null); setStatus('needs-session'); return; }
    const current = ++generation.current;
    const controller = new AbortController();
    setStatus((previous) => (previous === 'ready' ? 'ready' : 'loading'));
    setError(null);
    fetchFeed(kind, null, maxItems ?? pageSize, controller.signal)
      .then((page) => {
        if (current !== generation.current) return;
        upsertPosts(page.items);
        setIds(page.items.map((post) => post.id));
        setCursor(maxItems ? null : page.nextCursor);
        setSnapshot(page.snapshotMaxSeq);
        setNewCount(0);
        setStatus('ready');
      })
      .catch((reason) => {
        if (current !== generation.current || (reason instanceof ApiError && reason.code === 'aborted')) return;
        if (reason instanceof ApiError && reason.status === 401) { setStatus('needs-session'); return; }
        setError(reason instanceof ApiError ? reason.message : 'Could not load mogs.');
        setStatus('error');
      });
    return () => controller.abort();
  }, [kind, pageSize, maxItems, epoch, reloadToken, sessionReady, sessionActive, needsSession]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);
    try {
      const page = await fetchFeed(kind, cursor, pageSize);
      if (current !== generation.current) return;
      upsertPosts(page.items);
      // De-duplicate by public ID across pages.
      setIds((previous) => [...previous, ...page.items.map((post) => post.id).filter((id) => !previous.includes(id))]);
      setCursor(page.nextCursor);
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof ApiError ? reason.message : 'Could not load more.');
    } finally {
      if (current === generation.current) setLoadingMore(false);
    }
  }, [cursor, kind, loadingMore, pageSize]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  // Newly published posts appear in the viewer's own feeds right away.
  useEffect(() => onPublished((post) => {
    if (kind === 'latest' && snapshot !== null) { setIds((previous) => (previous.includes(post.id) ? previous : [post.id, ...previous])); setSnapshot((s) => Math.max(s ?? 0, post.feedSeq)); }
    if (kind !== 'latest') setIds((previous) => (previous.includes(post.id) ? previous : [post.id, ...previous]));
  }), [kind, snapshot]);

  // "N new mogs": poll only while visible, near the top, and not paused.
  useEffect(() => {
    if (!poll || kind !== 'latest' || paused || snapshot === null || status !== 'ready') return;
    let timer: number | null = null;
    let failures = 0;
    let stopped = false;
    const controller = new AbortController();
    const schedule = () => {
      if (stopped) return;
      const delay = Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** failures);
      timer = window.setTimeout(tick, delay);
    };
    const tick = async () => {
      if (document.visibilityState !== 'visible' || window.scrollY > NEAR_TOP_PX) { schedule(); return; }
      try {
        const head = await fetchHead(snapshot, controller.signal);
        failures = 0;
        if (!stopped) setNewCount(head.newCount);
      } catch {
        failures += 1;
      }
      schedule();
    };
    schedule();
    return () => { stopped = true; controller.abort(); if (timer) window.clearTimeout(timer); };
  }, [kind, poll, paused, snapshot, status]);

  // On focus: refresh session/viewer state and the counts of loaded cards.
  useEffect(() => {
    if (paused) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshSession().catch(() => undefined);
      void refreshPostStates(idsRef.current.slice(0, 100));
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); };
  }, [paused]);

  const visibleIds = useMemo(() => ids.filter((id) => {
    if (isDeleted(id)) return false;
    // Removing an Up Mog removes the post from My Up Mogs (restored if the vote fails).
    if (kind === 'upmogs') { const post = peekPost(id); return !post || post.viewerVote === 1 || isVotePending(id); }
    if (kind === 'mine') { const post = peekPost(id); return !post || post.isOwner; }
    return true;
  }), [ids, kind, storeVersion]);

  return { ids: visibleIds, status, error, hasMore: cursor !== null, loadingMore, loadMore, newCount, reload };
}
