// Normalized in-memory post cache shared by every mounted card, so the same
// post never shows different votes in Latest, detail, and My Up Mogs.
//
// Post revisions (counts) and viewer-vote revisions (this browser's selection)
// are reconciled separately: an old poll can't overwrite a newer vote, and an
// old vote response can't lower counts from a newer post revision.

import { useCallback, useSyncExternalStore } from 'react';
import { ApiError } from '../api/client';
import { ensureSession, markSessionLost, onIdentityChange, refreshSession } from '../api/session';
import { deletePost, fetchPostStates, putVote } from './api';
import type { MogPost, PostStateItem, VoteState, VoteValue } from './types';

const posts = new Map<string, MogPost>();
const pendingVotes = new Set<string>();
const deletedIds = new Set<string>();
const voteErrors = new Map<string, string>();
const listeners = new Set<() => void>();
const publishedListeners = new Set<(post: MogPost) => void>();
let version = 0;
let viewerEpoch = 0;

function emit() {
  version += 1;
  listeners.forEach((listener) => listener());
}

export function subscribeStore(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ---- Cross-tab invalidation (an optimization, never an ownership mechanism) ----
type TabMessage = { type: 'posts'; ids: string[] } | { type: 'identity' };
const channel: BroadcastChannel | null = typeof BroadcastChannel === 'function' ? new BroadcastChannel('mog-social') : null;
let handlingRemoteIdentity = false;

function broadcast(message: TabMessage) {
  try { channel?.postMessage(message); } catch { /* channel closed */ }
}

channel?.addEventListener('message', (event: MessageEvent<TabMessage>) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'posts' && Array.isArray(message.ids)) {
    void refreshPostStates(message.ids.filter((id) => typeof id === 'string' && posts.has(id)).slice(0, 50));
  } else if (message.type === 'identity') {
    handlingRemoteIdentity = true;
    void refreshSession().catch(() => undefined).finally(() => { handlingRemoteIdentity = false; });
  }
});

// Discard all viewer-specific fields before rendering them for a new identity.
onIdentityChange((previous, _next, fresh) => {
  for (const [id, post] of posts) posts.set(id, { ...post, viewerVote: 0, viewerVoteRevision: 0, isOwner: false });
  voteErrors.clear();
  // Feeds refetch viewer fields unless this tab just created an empty identity.
  if (previous !== null || !fresh) viewerEpoch += 1;
  if (!handlingRemoteIdentity) broadcast({ type: 'identity' });
  emit();
});

// ---- Merging -------------------------------------------------------------------

function merge(existing: MogPost | undefined, incoming: MogPost): MogPost {
  if (!existing) return incoming;
  const countsFresh = incoming.postRevision >= existing.postRevision;
  const viewerFresh = !pendingVotes.has(incoming.id) && incoming.viewerVoteRevision >= existing.viewerVoteRevision;
  const base = countsFresh ? incoming : { ...incoming, mogScore: existing.mogScore, upCount: existing.upCount, downCount: existing.downCount, postRevision: existing.postRevision };
  return viewerFresh ? base : { ...base, viewerVote: existing.viewerVote, viewerVoteRevision: existing.viewerVoteRevision };
}

function applyState(state: VoteState, forceViewer: boolean) {
  const existing = posts.get(state.postId);
  if (!existing) return;
  let next = existing;
  if (state.postRevision >= existing.postRevision) {
    next = { ...next, mogScore: state.mogScore, upCount: state.upCount, downCount: state.downCount, postRevision: state.postRevision };
  }
  if (typeof state.commentCount === 'number' && state.commentCount !== next.commentCount) next = { ...next, commentCount: state.commentCount };
  if (forceViewer || (!pendingVotes.has(state.postId) && state.viewerVoteRevision >= existing.viewerVoteRevision)) {
    next = { ...next, viewerVote: state.viewerVote, viewerVoteRevision: state.viewerVoteRevision };
  }
  if (next !== existing) posts.set(state.postId, next);
}

export function upsertPosts(items: MogPost[]) {
  if (!items.length) return;
  for (const item of items) {
    deletedIds.delete(item.id);
    posts.set(item.id, merge(posts.get(item.id), item));
  }
  emit();
}

export function markDeleted(id: string) {
  deletedIds.add(id);
  pendingVotes.delete(id);
  emit();
}

function applyStateItems(items: PostStateItem[]) {
  for (const item of items) {
    if (item.status === 'active') applyState(item, false);
    else deletedIds.add(item.postId);
  }
  emit();
}

/** Refresh counts and viewer vote state for visible cards (<= 50 per request). */
export async function refreshPostStates(ids: string[]) {
  const unique = [...new Set(ids)].filter((id) => !deletedIds.has(id));
  for (let i = 0; i < unique.length; i += 50) {
    try { applyStateItems(await fetchPostStates(unique.slice(i, i + 50))); } catch { /* next focus/poll retries */ }
  }
}

/** Authoritative comment count returned by a comment create/delete. */
export function setCommentCount(postId: string, count: number) {
  const post = posts.get(postId);
  if (!post || post.commentCount === count) return;
  posts.set(postId, { ...post, commentCount: count });
  emit();
}

export function notifyPublished(post: MogPost) {
  upsertPosts([post]);
  publishedListeners.forEach((listener) => listener(post));
  broadcast({ type: 'posts', ids: [post.id] });
}

export function onPublished(listener: (post: MogPost) => void) {
  publishedListeners.add(listener);
  return () => { publishedListeners.delete(listener); };
}

// ---- Voting ----------------------------------------------------------------------

/** Exact toggle rules: clicking the selected button clears it; the other selects. */
export function desiredVote(current: VoteValue, clicked: 1 | -1): VoteValue {
  return current === clicked ? 0 : clicked;
}

function predicted(post: MogPost, value: VoteValue): MogPost {
  const old = post.viewerVote;
  const upDelta = Number(value === 1) - Number(old === 1);
  const downDelta = Number(value === -1) - Number(old === -1);
  return { ...post, viewerVote: value, upCount: post.upCount + upDelta, downCount: post.downCount + downDelta, mogScore: post.mogScore + upDelta - downDelta };
}

export async function castVote(id: string, clicked: 1 | -1) {
  if (!posts.has(id) || pendingVotes.has(id) || deletedIds.has(id)) return; // one vote request per post in flight
  pendingVotes.add(id);
  voteErrors.delete(id);
  emit();
  let previous: MogPost | undefined;
  try {
    await ensureSession(); // no-op after the first confirmed session in this tab
    const base = posts.get(id);
    if (!base || deletedIds.has(id)) return;
    previous = base;
    const desired = desiredVote(base.viewerVote, clicked);
    posts.set(id, predicted(base, desired));
    emit();
    const state = await putVote(id, desired, base.viewerVoteRevision);
    pendingVotes.delete(id);
    applyState(state, true);
    broadcast({ type: 'posts', ids: [id] });
  } catch (error) {
    pendingVotes.delete(id);
    const apiError = error instanceof ApiError ? error : null;
    if (previous) posts.set(id, previous);
    if (apiError?.code === 'vote_conflict' && apiError.details) {
      // Apply the server's state and let the visitor choose again; never resubmit.
      applyState(apiError.details as unknown as VoteState, true);
      voteErrors.set(id, 'Your vote changed in another tab. Showing the latest.');
    } else if (apiError?.status === 410 || (apiError?.status === 404 && apiError.code === 'post_not_found')) {
      markDeleted(id);
    } else {
      if (apiError?.status === 401 && apiError.code === 'session_required') {
        markSessionLost();
        voteErrors.set(id, 'Your anonymous session ended. Tap again to start a new one.');
      } else {
        voteErrors.set(id, apiError?.message ?? 'Vote failed. Try again.');
      }
      void refreshPostStates([id]); // never leave an unconfirmed count behind
    }
  } finally {
    pendingVotes.delete(id);
    emit();
  }
}

export async function removeOwnPost(id: string) {
  await deletePost(id);
  markDeleted(id);
  broadcast({ type: 'posts', ids: [id] });
}

// ---- Hooks -------------------------------------------------------------------------

export function usePost(id: string | null) {
  const get = useCallback(() => (id ? posts.get(id) : undefined), [id]);
  return useSyncExternalStore(subscribeStore, get, get);
}

export function usePostMeta(id: string) {
  const pending = useSyncExternalStore(subscribeStore, () => pendingVotes.has(id), () => false);
  const deleted = useSyncExternalStore(subscribeStore, () => deletedIds.has(id), () => false);
  const error = useSyncExternalStore(subscribeStore, () => voteErrors.get(id) ?? null, () => null);
  return { pending, deleted, error };
}

export function useStoreVersion() {
  return useSyncExternalStore(subscribeStore, () => version, () => version);
}

export function useViewerEpoch() {
  return useSyncExternalStore(subscribeStore, () => viewerEpoch, () => viewerEpoch);
}

export function peekPost(id: string) { return posts.get(id); }
export function isDeleted(id: string) { return deletedIds.has(id); }
export function isVotePending(id: string) { return pendingVotes.has(id); }
