import { useEffect, useMemo, useRef, useState } from 'react';
import { playEditTrack, type EditAudio } from '../editAudio';
import { buildMogTimeline, type EditFace } from '../mogTimeline';
import moggedStamp from '../assets/mogged.png';
import editTrack from '../assets/edit-track.mp3';

type MogEditProps = { faces: EditFace[]; loading: boolean; fixedParticipants?: boolean; onClose: () => void };

export function MogEdit({ faces, loading, fixedParticipants = false, onClose }: MogEditProps) {
  const [personAId, setPersonAId] = useState('');
  const [personBId, setPersonBId] = useState('');
  const [playing, setPlaying] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [muted, setMuted] = useState(false);
  const audioRef = useRef<EditAudio | null>(null);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    if (!personAId && faces[0]) setPersonAId(faces[0].id);
    if (!personBId && faces[1]) setPersonBId(faces[1].id);
  }, [faces, personAId, personBId]);

  useEffect(() => () => {
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    audioRef.current?.stop();
  }, []);

  const personA = faces.find((face) => face.id === personAId) ?? null;
  const personB = faces.find((face) => face.id === personBId) ?? null;
  const timeline = useMemo(() => personA && personB ? buildMogTimeline(personA, personB) : null, [personA, personB]);
  const scene = timeline?.sceneAt(elapsedMs) ?? 'intro-a';
  const loser = timeline?.comparison.winner === 'a' ? 'b' : timeline?.comparison.winner === 'b' ? 'a' : null;
  const showMogged = loser !== null && elapsedMs >= 10_800 && elapsedMs < 11_700;
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  const stop = () => {
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    audioRef.current?.stop();
    audioRef.current = null;
    setPlaying(false);
  };

  const play = async () => {
    if (!timeline || !personA || !personB) return;
    stop();
    setElapsedMs(0);
    audioRef.current = await playEditTrack(muted, editTrack);
    const startedAt = performance.now();
    const render = (now: number) => {
      const nextElapsed = Math.min(now - startedAt, timeline.durationMs);
      setElapsedMs(nextElapsed);
      if (nextElapsed < timeline.durationMs) animationRef.current = requestAnimationFrame(render);
      else { audioRef.current?.stop(); audioRef.current = null; setPlaying(false); }
    };
    setPlaying(true);
    animationRef.current = requestAnimationFrame(render);
  };

  const swap = () => {
    stop();
    setElapsedMs(0);
    setPersonAId(personBId);
    setPersonBId(personAId);
  };

  const toggleMute = () => {
    const nextMuted = !muted;
    setMuted(nextMuted);
    audioRef.current?.setMuted(nextMuted);
  };

  return <div className="modal edit-modal" role="dialog" aria-modal="true" aria-label="Who Mogs Who edit">
    <div className="modal-card edit-modal-card edit-window-card">
      <div className="edit-heading"><div><p className="eyebrow">LOCAL PHOTO PLAYBACK</p><h2>Who Mogs Who?</h2></div><button className="text-button" onClick={() => { stop(); onClose(); }}>Close</button></div>
      {loading && <p>Loading saved local photos…</p>}
      {!loading && faces.length < 2 && <p>Save scan photos for at least two leaderboard entries before making an edit. Photos never leave this browser.</p>}
      {!loading && faces.length >= 2 && personA && personB && timeline && <>
        <div className="edit-window-content">
          <div className={`edit-player scene-${scene} winner-${timeline.comparison.winner} ${showMogged ? `mogged-${loser}` : ''} ${playing ? 'is-playing' : 'is-still'} ${reduceMotion ? 'reduce-motion' : ''}`}>
            <img className="edit-face edit-face-a" src={personA.imageUrl} alt={personA.displayName} />
            <img className="edit-face edit-face-b" src={personB.imageUrl} alt={personB.displayName} />
            {(personA.lowResolution || personB.lowResolution) && <span className="edit-low-resolution">LOW-RES SOURCE · PLAYBACK OPTIMIZED</span>}
            <div className="edit-vignette" />
            <div className="edit-label label-a"><span>SUBJECT A</span><b>{personA.displayName}</b></div>
            <div className="edit-label label-b"><span>SUBJECT B</span><b>{personB.displayName}</b></div>
            <div className="edit-vs">VS</div>
            <div className="edit-suspense">VERDICT INCOMING</div>
            {showMogged && <img className="edit-mogged-stamp" src={moggedStamp} alt="Mogged" />}
            <div className="edit-reveal">{timeline.comparison.winner === 'tie' ? <><span>NO ONE MOGS</span><b>IT’S A TIE</b><small>{personA.score} — {personB.score}</small></> : <><span>WINNER</span><b>{timeline.comparison.winner === 'a' ? personA.displayName : personB.displayName}</b><small>{timeline.comparison.label} · {personA.score} — {personB.score}</small></>}</div>
            <div className="edit-progress"><i style={{ width: `${Math.min(100, elapsedMs / timeline.durationMs * 100)}%` }} /></div>
          </div>
          <aside className="edit-controls-panel">
            {!fixedParticipants && <div className="edit-selectors"><label>Subject A<select value={personAId} onChange={(event) => { stop(); setPersonAId(event.target.value); }}>{faces.map((face) => <option key={face.id} value={face.id} disabled={face.id === personBId}>{face.displayName}</option>)}</select></label><label>Subject B<select value={personBId} onChange={(event) => { stop(); setPersonBId(event.target.value); }}>{faces.map((face) => <option key={face.id} value={face.id} disabled={face.id === personAId}>{face.displayName}</option>)}</select></label></div>}
            <div className="actions edit-actions"><button className="primary" onClick={() => void play()}>{playing ? 'Restart edit' : elapsedMs ? 'Replay edit' : 'Generate edit'} <span aria-hidden="true">↗</span></button>{!fixedParticipants && <button className="secondary" onClick={swap}>Swap</button>}<button className="secondary" onClick={toggleMute}>{muted ? 'Unmute' : 'Mute'}</button></div>
            <p className="edit-note">15-second local playback · bundled track · result uses the two saved scan scores, not a new scan.</p>
          </aside>
        </div>
      </>}
    </div>
  </div>;
}
