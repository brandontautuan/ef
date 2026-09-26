import type { LeaderboardEntry } from './leaderboard';

export type EditFace = LeaderboardEntry & { imageUrl: string; lowResolution: boolean };
export type EditScene = 'intro-a' | 'intro-b' | 'versus' | 'suspense' | 'reveal' | 'outro';

export type ComparisonResult = {
  winner: 'a' | 'b' | 'tie';
  difference: number;
  label: string;
};

export type MogTimeline = {
  durationMs: number;
  beatsMs: number[];
  sceneAt: (elapsedMs: number) => EditScene;
  comparison: ComparisonResult;
};

const durationMs = 15_400;
const beatsMs = [0, 900, 1_800, 2_700, 3_600, 4_500, 5_400, 6_300, 7_200, 8_100, 9_000, 9_900, 10_800, 11_700, 12_600, 13_500, 14_400];

export function buildMogTimeline(personA: EditFace, personB: EditFace): MogTimeline {
  const difference = Math.abs(personA.score - personB.score);
  const winner = difference === 0 ? 'tie' : personA.score > personB.score ? 'a' : 'b';
  return {
    durationMs,
    beatsMs,
    comparison: { winner, difference, label: winner === 'tie' ? 'TIE — NO VERDICT' : `+${difference} POINTS` },
    sceneAt: (elapsedMs) => {
      if (elapsedMs < 3_600) return 'intro-a';
      if (elapsedMs < 7_200) return 'intro-b';
      if (elapsedMs < 8_100) return 'versus';
      if (elapsedMs < 11_700) return 'suspense';
      if (elapsedMs < 14_400) return 'reveal';
      return 'outro';
    },
  };
}
