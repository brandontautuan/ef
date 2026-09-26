export type LeaderboardEntry = { id: string; displayName: string; score: number; tier: string; modelVersion: string; createdAt: string; updatedAt: string };
const KEY = 'mog_scan.leaderboard.v1';
const limit = 100;

const valid = (value: unknown): value is LeaderboardEntry => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && typeof item.displayName === 'string' && item.displayName.length >= 2 && item.displayName.length <= 20 && typeof item.score === 'number' && Number.isInteger(item.score) && item.score >= 0 && item.score <= 100 && typeof item.tier === 'string' && typeof item.modelVersion === 'string' && typeof item.createdAt === 'string' && typeof item.updatedAt === 'string';
};
export const rank = (entries: LeaderboardEntry[]) => [...entries].sort((a, b) => b.score - a.score || a.updatedAt.localeCompare(b.updatedAt));
export const loadLeaderboard = (): LeaderboardEntry[] => { try { const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(raw) ? rank(raw.filter(valid)).slice(0, limit) : []; } catch { return []; } };
export const saveLeaderboard = (entries: LeaderboardEntry[]) => localStorage.setItem(KEY, JSON.stringify(rank(entries).slice(0, limit)));
export const normalizeName = (name: string) => name.trim().replace(/\s+/g, ' ');
export const clearLeaderboard = () => localStorage.removeItem(KEY);
