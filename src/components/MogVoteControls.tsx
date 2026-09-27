import { mogLabel } from '../social/format';
import type { MogPost } from '../social/types';
import { castVote, usePostMeta } from '../social/useSocialStore';

type Props = { post: MogPost };

// Exact toggle rules live in the store (desiredVote); this renders the selected
// state, the net count, and disables input while one vote is in flight.
export function MogVoteControls({ post }: Props) {
  const { pending, error } = usePostMeta(post.id);
  return <div className="mog-votes">
    <div className="mog-vote-row" role="group" aria-label="Vote on this mog">
      <button type="button" className={`vote-button up${post.viewerVote === 1 ? ' selected' : ''}`} aria-pressed={post.viewerVote === 1} aria-label="Up Mog" disabled={pending} onClick={() => void castVote(post.id, 1)}>
        <span aria-hidden="true">▲</span> Up Mog
      </button>
      <output className={`mog-count${post.mogScore < 0 ? ' negative' : ''}`} aria-live="polite" aria-label={`${mogLabel(post.mogScore)}, net`}>{mogLabel(post.mogScore)}</output>
      <button type="button" className={`vote-button down${post.viewerVote === -1 ? ' selected' : ''}`} aria-pressed={post.viewerVote === -1} aria-label="Down Mog" disabled={pending} onClick={() => void castVote(post.id, -1)}>
        <span aria-hidden="true">▼</span> Down Mog
      </button>
    </div>
    {error && <p className="mog-inline-error" role="status">{error}</p>}
  </div>;
}
