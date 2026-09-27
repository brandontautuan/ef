// Normalized comment cache with the same optimistic, revision-aware voting as
// posts. Comment revisions (counts) and viewer-vote revisions are reconciled
// separately so late responses never overwrite newer state.

import { useCallback, useSyncExternalStore } from 'react';
import { ApiError } from '../api/client';
import { ensureSession, markSessionLost, onIdentityChange } from '../api/session';
import { deleteComment, putCommentVote } from './api';
import type { CommentVoteState, MogComment, VoteValue } from './types';
import { desiredVote, setCommentCount } from './useSocialStore';

const comments = new Map<string, MogComment>();
const pending = new Set<string>();
const errors = new Map<string, string>();
const removed = new Set<string>();
const listeners = new Set<() => void>();

function emit() { listeners.forEach((listener) => listener()); }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

onIdentityChange(() => {
  for (const [id, comment] of comments) comments.set(id, { ...comment, viewerVote: 0, viewerVoteRevision: 0, isAuthor: false });
  errors.clear();
  emit();
});

function merge(existing: MogComment | undefined, incoming: MogComment): MogComment {
  if (!existing) return incoming;
  const countsFresh = incoming.commentRevision >= existing.commentRevision;
  const viewerFresh = !pending.has(incoming.id) && incoming.viewerVoteRevision >= existing.viewerVoteRevision;
  const base = countsFresh ? incoming : { ...incoming, mogScore: existing.mogScore, upCount: existing.upCount, downCount: existing.downCount, commentRevision: existing.commentRevision };
  return viewerFresh ? base : { ...base, viewerVote: existing.viewerVote, viewerVoteRevision: existing.viewerVoteRevision };
}

export function upsertComments(items: MogComment[]) {
  for (const item of items) { removed.delete(item.id); comments.set(item.id, merge(comments.get(item.id), item)); }
  emit();
}

function applyState(state: CommentVoteState) {
  const existing = comments.get(state.commentId);
  if (!existing) return;
  let next = existing;
  if (state.commentRevision >= existing.commentRevision) next = { ...next, mogScore: state.mogScore, upCount: state.upCount, downCount: state.downCount, commentRevision: state.commentRevision };
  next = { ...next, viewerVote: state.viewerVote, viewerVoteRevision: state.viewerVoteRevision };
  comments.set(state.commentId, next);
}

function predicted(comment: MogComment, value: VoteValue): MogComment {
  const up = Number(value === 1) - Number(comment.viewerVote === 1);
  const down = Number(value === -1) - Number(comment.viewerVote === -1);
  return { ...comment, viewerVote: value, upCount: comment.upCount + up, downCount: comment.downCount + down, mogScore: comment.mogScore + up - down };
}

export async function castCommentVote(id: string, clicked: 1 | -1) {
  if (!comments.has(id) || pending.has(id) || removed.has(id)) return;
  pending.add(id); errors.delete(id); emit();
  let previous: MogComment | undefined;
  try {
    await ensureSession();
    const base = comments.get(id);
    if (!base || removed.has(id)) return;
    previous = base;
    const desired = desiredVote(base.viewerVote, clicked);
    comments.set(id, predicted(base, desired)); emit();
    const state = await putCommentVote(id, desired, base.viewerVoteRevision);
    pending.delete(id);
    applyState(state);
  } catch (error) {
    pending.delete(id);
    const apiError = error instanceof ApiError ? error : null;
    if (previous) comments.set(id, previous);
    if (apiError?.code === 'vote_conflict' && apiError.details) {
      applyState(apiError.details as unknown as CommentVoteState);
      errors.set(id, 'Your vote changed in another tab. Showing the latest.');
    } else if (apiError?.status === 410) {
      removed.add(id);
    } else if (apiError?.status === 401 && apiError.code === 'session_required') {
      markSessionLost();
      errors.set(id, 'Your anonymous session ended. Tap again to start a new one.');
    } else {
      errors.set(id, apiError?.message ?? 'Vote failed. Try again.');
    }
  } finally {
    pending.delete(id);
    emit();
  }
}

export async function removeOwnComment(id: string) {
  const comment = comments.get(id);
  const { commentCount } = await deleteComment(id);
  removed.add(id);
  if (comment) setCommentCount(comment.postId, commentCount);
  emit();
}

export function useComment(id: string) {
  const get = useCallback(() => comments.get(id), [id]);
  return useSyncExternalStore(subscribe, get, get);
}

export function useCommentMeta(id: string) {
  const isPending = useSyncExternalStore(subscribe, () => pending.has(id), () => false);
  const isRemoved = useSyncExternalStore(subscribe, () => removed.has(id), () => false);
  const error = useSyncExternalStore(subscribe, () => errors.get(id) ?? null, () => null);
  return { pending: isPending, removed: isRemoved, error };
}
