// Typed calls for the social, leaderboard, and registered-scan endpoints.

import { apiRequest } from '../api/client';
import type {
  FeedHead,
  FeedKind,
  FeedPage,
  LeaderboardPage,
  LeaderboardSubmit,
  MogPost,
  PostStateItem,
  ServerScanResult,
  ShareableResult,
  VoteState,
  VoteValue,
} from './types';

const FEED_PATHS: Record<FeedKind, string> = { latest: '/posts', mine: '/me/posts', upmogs: '/me/upmogs' };
const query = (params: Record<string, string | number | null | undefined>) => {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => { if (value !== null && value !== undefined && value !== '') search.set(key, String(value)); });
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const fetchFeed = (kind: FeedKind, cursor: string | null, limit = 20, signal?: AbortSignal) =>
  apiRequest<FeedPage>(`${FEED_PATHS[kind]}${query({ cursor, limit })}`, { retries: 2, signal });

export const fetchHead = (afterSeq: number, signal?: AbortSignal) =>
  apiRequest<FeedHead>(`/posts/head${query({ after_seq: afterSeq })}`, { signal });

export const fetchPost = (id: string) =>
  apiRequest<{ post: MogPost }>(`/posts/${encodeURIComponent(id)}`, { retries: 2 }).then((body) => body.post);

export const fetchPostStates = (ids: string[]) =>
  apiRequest<{ items: PostStateItem[] }>('/posts/state', { method: 'POST', body: { ids }, retries: 1 }).then((body) => body.items);

export const publishPost = (input: { resultId: string; caption: string | null; includePhoto: boolean }, idempotencyKey: string) =>
  apiRequest<{ post: MogPost; created: boolean }>('/posts', {
    method: 'POST',
    body: { result_id: input.resultId, caption: input.caption, include_photo: input.includePhoto },
    idempotencyKey,
    retries: 2, // same key + same payload: a retry can never create a second post
  });

export const putVote = (id: string, value: VoteValue, expectedVoteRevision: number) =>
  apiRequest<VoteState>(`/posts/${encodeURIComponent(id)}/vote`, {
    method: 'PUT',
    body: { value, expected_vote_revision: expectedVoteRevision },
    retries: 1, // desired state + original revision: a retry is a no-op if it already applied
  });

export const deletePost = (id: string) =>
  apiRequest<void>(`/posts/${encodeURIComponent(id)}`, { method: 'DELETE', retries: 1 });

export const fetchShareableResults = (cursor: string | null = null) =>
  apiRequest<{ items: ShareableResult[]; nextCursor: string | null }>(`/me/shareable-results${query({ cursor, limit: 20 })}`, { retries: 1 });

// ---- Shared leaderboard -------------------------------------------------------

export const fetchLeaderboard = (cursor: string | null = null, captureMode: 'live' | 'upload' = 'live') =>
  apiRequest<LeaderboardPage>(`/leaderboard${query({ cursor, capture_mode: captureMode, limit: 50 })}`, { retries: 2 });

export const submitLeaderboard = (resultId: string, displayName: string, confirmReplace: boolean) =>
  apiRequest<LeaderboardSubmit>('/leaderboard', {
    method: 'POST',
    body: { result_id: resultId, display_name: displayName, confirm_replace: confirmReplace },
    retries: 1,
  });

export const removeMyLeaderboardEntry = (captureMode: 'live' | 'upload') =>
  apiRequest<void>(`/leaderboard/me${query({ capture_mode: captureMode })}`, { method: 'DELETE' });

// ---- Registered scans ---------------------------------------------------------

export type RegisteredScan = { scan_id: string; required_frames: number; model_version: string; display_map_version: string };
export type FrameAck = {
  scan_id: string;
  frame_sequence: number;
  accepted_frames: number;
  required_frames: number;
  status: 'collecting' | 'complete';
  native_score: number | null;
  model_version: string;
  result: ServerScanResult | null;
};

export const createScan = (captureMode: 'live' | 'upload') =>
  apiRequest<RegisteredScan>('/scans', { method: 'POST', body: { capture_mode: captureMode }, retries: 1 });

export function submitScanFrame(scanId: string, blob: Blob, sequence: number) {
  const form = new FormData();
  form.append('image', blob, 'selected-face.jpg');
  form.append('frame_sequence', String(sequence));
  // Retrying the same sequence returns the cached acknowledgment, never a second sample.
  return apiRequest<FrameAck>(`/scans/${encodeURIComponent(scanId)}/frames`, { method: 'POST', form, timeoutMs: 8_000, retries: 1 });
}
