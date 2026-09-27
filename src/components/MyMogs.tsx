import { useEffect, useState } from 'react';
import { useSession } from '../api/session';
import { fetchShareableResults } from '../social/api';
import type { ShareableResult } from '../social/types';
import type { AppRoute } from '../social/useAppRoute';
import { onPublished } from '../social/useSocialStore';
import { MogFeed } from './MogFeed';
import type { ShareSource } from './ShareMogSheet';

type Props = { tab: 'my-mogs' | 'my-upmogs'; onNavigate: (route: AppRoute) => void; onShare: (source: ShareSource) => void };

// Both lists come from server queries resolved by this browser's cookie; nothing
// is saved in browser storage. Sharing this URL does not share ownership.
export function MyMogs({ tab, onNavigate, onShare }: Props) {
  const session = useSession();
  const [shareable, setShareable] = useState<ShareableResult[]>([]);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => onPublished(() => setRefresh((value) => value + 1)), []);
  useEffect(() => {
    if (tab !== 'my-mogs' || session.status !== 'active') { setShareable([]); return; }
    let active = true;
    fetchShareableResults().then((page) => { if (active) setShareable(page.items.filter((item) => !item.postStatus && item.revealComplete !== false)); }).catch(() => undefined);
    return () => { active = false; };
  }, [tab, session.status, session.viewerKey, refresh]);

  return <div className="my-mogs">
    <div className="social-tabs" role="tablist" aria-label="Your mogs">
      <button type="button" role="tab" aria-selected={tab === 'my-mogs'} className={tab === 'my-mogs' ? 'active' : ''} onClick={() => onNavigate({ name: 'my-mogs' })}>My Mogs</button>
      <button type="button" role="tab" aria-selected={tab === 'my-upmogs'} className={tab === 'my-upmogs' ? 'active' : ''} onClick={() => onNavigate({ name: 'my-upmogs' })}>My Up Mogs</button>
    </div>
    <p className="social-note">Tied to this browser only. A different browser, device, or private window is a different anonymous identity, and clearing cookies removes your delete and vote controls here.</p>
    {tab === 'my-mogs' && shareable.length > 0 && <section className="shareable" aria-label="Results you can share">
      <p className="eyebrow">READY TO SHARE</p>
      <ul>{shareable.map((item) => <li key={item.resultId}>
        <span><b>{item.score}</b>/100 · {item.tier} <small>{item.captureMode === 'upload' ? 'UPLOAD' : 'LIVE'}</small></span>
        <button type="button" className="text-button strong" onClick={() => onShare(item)}>Share as mog</button>
      </li>)}</ul>
    </section>}
    {tab === 'my-mogs'
      ? <MogFeed key="mine" kind="mine" onNavigate={onNavigate} empty={<p className="feed-status">You haven’t posted a mog yet. Save a scan to the shared leaderboard, then tap Share as mog.</p>} />
      : <MogFeed key="upmogs" kind="upmogs" onNavigate={onNavigate} empty={<p className="feed-status">No Up Mogs yet. Posts you Up Mog (including your own) land here.</p>} />}
  </div>;
}
