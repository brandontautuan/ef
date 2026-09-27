export const CAPTION_MAX = 280;

/** Mirrors the service: trim, normalize line endings, count Unicode code points. */
export function normalizeCaption(raw: string) {
  return raw.replace(/\r\n?/g, '\n').trim();
}

export function codePointLength(text: string) {
  return [...text].length;
}

// C0/C1 controls other than newline; the service rejects the same set.
export const hasControlChars = (text: string) => /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/.test(text);

export function relativeTime(iso: string, now = Date.now()) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined });
}

export const mogLabel = (count: number) => `${count} ${Math.abs(count) === 1 ? 'mog' : 'mogs'}`;
