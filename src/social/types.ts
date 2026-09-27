// Contracts for the anonymous social system. Field names mirror the service.

export type VoteValue = -1 | 0 | 1;

export type MogResult = {
  score: number;
  tier: string;
  modelVersion: string;
  displayMapVersion: string;
  captureMode: 'live' | 'upload';
  achievedAt: string;
};

export type MogPost = {
  id: string;
  feedSeq: number;
  createdAt: string;
  authorLabel: string;
  caption: string | null;
  result: MogResult;
  mediaUrl: string | null;
  mogScore: number;
  upCount: number;
  downCount: number;
  postRevision: number;
  viewerVote: VoteValue;
  viewerVoteRevision: number;
  isOwner: boolean;
  commentCount: number;
};

export type VoteState = {
  postId: string;
  mogScore: number;
  upCount: number;
  downCount: number;
  postRevision: number;
  viewerVote: VoteValue;
  viewerVoteRevision: number;
  commentCount?: number;
};

export type PostStateItem = ({ status: 'active' } & VoteState) | { status: 'deleted' | 'missing'; postId: string };

export type FeedKind = 'latest' | 'mine' | 'upmogs';

export type FeedPage = { items: MogPost[]; nextCursor: string | null; snapshotMaxSeq: number | null };

export type FeedHead = { newCount: number; capped: boolean; headSeq: number };

/** An owned result the viewer can share (a leaderboard publication). */
export type ShareableResult = {
  resultId: string;
  displayName: string;
  score: number;
  tier: string;
  modelVersion?: string;
  displayMapVersion?: string;
  captureMode: 'live' | 'upload';
  achievedAt: string;
  publishedAt?: string;
  postId: string | null;
  postStatus: 'active' | 'deleted' | null;
  photoAvailable: boolean;
  revealComplete?: boolean;
};

export type ServerScanResult = {
  id: string;
  score: number;
  tier: string;
  modelVersion: string;
  displayMapVersion: string;
  captureMode: 'live' | 'upload';
  createdAt: string;
};

export type LeaderboardRow = {
  entryId: string;
  rank: number;
  displayName: string;
  score: number;
  tier: string;
  achievedAt: string;
  isMine: boolean;
  resultId?: string;
  postId?: string | null;
  postStatus?: 'active' | 'deleted' | null;
};

export type LeaderboardPage = {
  cohort: { modelVersion: string; displayMapVersion: string; captureMode: 'live' | 'upload' };
  items: LeaderboardRow[];
  nextCursor: string | null;
  viewerEntry: LeaderboardRow | null;
};

export type LeaderboardSubmit = { outcome: 'inserted' | 'replaced' | 'unchanged' | 'not_higher'; entry: LeaderboardRow };

export type MogComment = {
  id: string;
  postId: string;
  seq: number;
  createdAt: string;
  authorLabel: string;
  body: string;
  isPostAuthor: boolean;
  mogScore: number;
  upCount: number;
  downCount: number;
  commentRevision: number;
  viewerVote: VoteValue;
  viewerVoteRevision: number;
  isAuthor: boolean;
};

export type CommentVoteState = {
  commentId: string;
  mogScore: number;
  upCount: number;
  downCount: number;
  commentRevision: number;
  viewerVote: VoteValue;
  viewerVoteRevision: number;
};

export type CommentPage = { items: MogComment[]; nextCursor: string | null; commentCount: number };
