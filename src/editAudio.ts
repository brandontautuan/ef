export type EditAudio = { setMuted: (muted: boolean) => void; stop: () => void };

// The supplied song is decoded and scheduled from the Generate/Replay gesture,
// which keeps it in sync with the fixed visual timeline and browser autoplay rules.
export async function playEditTrack(muted: boolean, trackUrl: string): Promise<EditAudio | null> {
  const AudioContextConstructor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return null;
  const context = new AudioContextConstructor();
  await context.resume();
  try {
    const response = await fetch(trackUrl);
    if (!response.ok) throw new Error('Track unavailable');
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
    const master = context.createGain();
    master.gain.value = muted ? 0 : .52;
    master.connect(context.destination);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(master);
    const start = context.currentTime + .04;
    source.start(start);
    master.gain.setValueAtTime(muted ? 0 : .52, start + 14.4);
    master.gain.linearRampToValueAtTime(.0001, start + 15.35);
    source.stop(start + 15.4);
    source.onended = () => void context.close();
    return {
      setMuted: (nextMuted) => master.gain.setTargetAtTime(nextMuted ? 0 : .52, context.currentTime, .02),
      stop: () => { try { source.stop(); } catch {} window.setTimeout(() => void context.close(), 80); },
    };
  } catch {
    await context.close();
    return null;
  }
}
