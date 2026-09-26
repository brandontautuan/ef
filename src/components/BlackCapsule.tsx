import type { CSSProperties } from 'react';

// Fixed trajectories keep the effect repeatable and avoid randomness on render.
const fragments = Array.from({ length: 28 }, (_, index) => ({
  '--scatter': `${((index * 73) % 360) - 180}px`,
  '--fall': `${260 + ((index * 43) % 170)}px`,
  '--spin': `${((index * 137) % 900) - 450}deg`,
  '--delay': `${160 + ((index * 37) % 240)}ms`,
  '--seed-x': `${((index * 17) % 50) - 25}px`,
  '--seed-y': `${((index * 23) % 60) - 30}px`,
}) as CSSProperties);

export function BlackCapsule({ opening = false }: { opening?: boolean }) {
  return <div className={`pill-scene${opening ? ' pill-scene--opening' : ''}`} aria-hidden="true">
    <div className="pill-orbit" />
    <div className="pill-shadow" />
    <div className="capsule">
      <div className="capsule-half capsule-left"><span>MOG</span><i /></div>
      <div className="capsule-half capsule-right"><span>100 MG</span></div>
      <div className="capsule-fill">
        {fragments.map((style, index) => <i key={index} className="micro-capsule" style={style} />)}
      </div>
    </div>
    {!opening && <><span className="pill-coordinate">FIG. 01 — THE BLACK CAPSULE</span><span className="pill-spec">HANDLE WITH HUMOR.</span></>}
  </div>;
}
