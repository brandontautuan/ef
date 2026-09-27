import { mogLabel } from '../social/format';
import type { VoteValue } from '../social/types';

type Props = {
  value: VoteValue;
  score: number;
  pending: boolean;
  onVote: (clicked: 1 | -1) => void;
  groupLabel: string;
  error?: string | null;
  compact?: boolean;
};

// Presentation only: Up Mog / count / Down Mog. The stores own the toggle rules.
export function VoteButtons({ value, score, pending, onVote, groupLabel, error, compact = false }: Props) {
  return <div className={`mog-votes${compact ? ' compact' : ''}`}>
    <div className="mog-vote-row" role="group" aria-label={groupLabel}>
      <button type="button" className={`vote-button up${value === 1 ? ' selected' : ''}`} aria-pressed={value === 1} aria-label="Up Mog" disabled={pending} onClick={() => onVote(1)}>
        <span aria-hidden="true">▲</span>{compact ? null : ' Up Mog'}
      </button>
      <output className={`mog-count${score < 0 ? ' negative' : ''}`} aria-live="polite" aria-label={`${mogLabel(score)}, net`}>{mogLabel(score)}</output>
      <button type="button" className={`vote-button down${value === -1 ? ' selected' : ''}`} aria-pressed={value === -1} aria-label="Down Mog" disabled={pending} onClick={() => onVote(-1)}>
        <span aria-hidden="true">▼</span>{compact ? null : ' Down Mog'}
      </button>
    </div>
    {error && <p className="mog-inline-error" role="status">{error}</p>}
  </div>;
}
