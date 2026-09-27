// Anonymous cookie session shared by scanning, leaderboard, and social.
//
// Identity is created only on the first action that needs ownership
// (POST /session), then confirmed with a following GET before the first
// mutation. Creation is single-flight within a tab and serialized across tabs
// with Web Locks where available. No token is ever visible to JavaScript.

import { useSyncExternalStore } from 'react';
import { ApiError, apiEnabled, apiRequest } from './client';

export type SessionStatus = 'unknown' | 'anonymous' | 'active' | 'blocked';
export type SessionState = { status: SessionStatus; viewerKey: string | null; displayName: string | null };
type SessionPayload = { authenticated: boolean; viewer: { key: string; displayName: string | null } | null };

let state: SessionState = { status: apiEnabled ? 'unknown' : 'anonymous', viewerKey: null, displayName: null };
const listeners = new Set<() => void>();
const identityListeners = new Set<(previous: string | null, next: string | null, fresh: boolean) => void>();
let inflight: Promise<SessionState> | null = null;
// Viewer key last confirmed by a server read inside ensureSession().
let confirmedKey: string | null = null;

function setState(next: SessionState, fresh = false) {
  const previousKey = state.viewerKey;
  state = next;
  listeners.forEach((listener) => listener());
  if (previousKey !== next.viewerKey && (previousKey !== null || next.viewerKey !== null)) {
    identityListeners.forEach((listener) => listener(previousKey, next.viewerKey, fresh));
  }
}

function fromPayload(payload: SessionPayload): SessionState {
  return payload.authenticated && payload.viewer
    ? { status: 'active', viewerKey: payload.viewer.key, displayName: payload.viewer.displayName }
    : { status: 'anonymous', viewerKey: null, displayName: null };
}

export function getSession() { return state; }

export function subscribeSession(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Called when the resolved identity changes (another tab replaced the cookie, it expired, ...). */
export function onIdentityChange(listener: (previous: string | null, next: string | null, fresh: boolean) => void) {
  identityListeners.add(listener);
  return () => { identityListeners.delete(listener); };
}

export function useSession() {
  return useSyncExternalStore(subscribeSession, getSession, getSession);
}

/** Re-read the server session. Never creates an identity. */
export async function refreshSession(): Promise<SessionState> {
  if (!apiEnabled) return state;
  let payload: SessionPayload;
  try {
    payload = await apiRequest<SessionPayload>('/session', { retries: 1 });
  } catch (error) {
    // Unreachable API: browsing continues without viewer-specific state.
    if (state.status === 'unknown') setState({ status: 'anonymous', viewerKey: null, displayName: null });
    throw error;
  }
  const next = fromPayload(payload);
  // A blocked-cookie result stays sticky until an explicit retry succeeds.
  if (!(state.status === 'blocked' && next.status === 'anonymous')) setState(next);
  return state;
}

async function createAndConfirm(): Promise<SessionState> {
  const current = fromPayload(await apiRequest<SessionPayload>('/session', { retries: 1 }));
  if (current.status === 'active') { setState(current); confirmedKey = current.viewerKey; return current; }
  const created = await apiRequest<SessionPayload & { created?: boolean }>('/session', { method: 'POST', retries: 1 });
  // Confirm the cookie was actually stored before enabling the first mutation.
  const confirmed = fromPayload(await apiRequest<SessionPayload>('/session'));
  if (confirmed.status !== 'active') {
    setState({ status: 'blocked', viewerKey: null, displayName: null });
    throw new ApiError(401, 'cookies_blocked', 'Your browser blocked the anonymous cookie. Allow cookies for this site to post and vote.');
  }
  // A brand-new identity cannot own posts or votes yet, so caches need no reload.
  setState(confirmed, created.created === true);
  confirmedKey = confirmed.viewerKey;
  return confirmed;
}

/** Ensure a confirmed session exists before an ownership action. */
export function ensureSession(): Promise<SessionState> {
  if (!apiEnabled) return Promise.reject(new ApiError(0, 'api_disabled', 'Sharing is not configured for this build.'));
  if (state.status === 'active' && state.viewerKey !== null && state.viewerKey === confirmedKey) return Promise.resolve(state);
  if (!inflight) {
    const run = () => createAndConfirm();
    // Serialize first-session creation across tabs; each tab re-reads inside the lock.
    const locked = typeof navigator !== 'undefined' && navigator.locks
      ? (navigator.locks.request('mog-session-bootstrap', run) as unknown as Promise<SessionState>)
      : run();
    inflight = locked.finally(() => { inflight = null; });
  }
  return inflight as Promise<SessionState>;
}

/** A mutation reported 401: the cookie is gone; reset viewer state. */
export function markSessionLost() {
  confirmedKey = null;
  setState({ status: 'anonymous', viewerKey: null, displayName: null });
}
