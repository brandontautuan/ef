import type { MogPost } from '../social/types';
import { castVote, usePostMeta } from '../social/useSocialStore';
import { VoteButtons } from './VoteButtons';

type Props = { post: MogPost };

// Exact toggle rules live in the store (desiredVote); this renders the selected
// state, the net count, and disables input while one vote is in flight.
export function MogVoteControls({ post }: Props) {
  const { pending, error } = usePostMeta(post.id);
  return <VoteButtons value={post.viewerVote} score={post.mogScore} pending={pending} error={error} groupLabel="Vote on this mog" onVote={(clicked) => void castVote(post.id, clicked)} />;
}
