// Hash routes and the parent/iframe bridge.
//
// Public URLs live on the homepage wrapper (https://mog.zo.space/#/mogs/<id>),
// which embeds this app in a same-origin iframe. Inside the iframe the parent's
// hash is the source of truth: the wrapper sends `mog:navigate`, and inner
// navigation sends `mog:route` so the wrapper can update its hash and history.
// Standalone (development), the app uses its own window hash.

import { useCallback, useEffect, useRef, useState } from 'react';

export type AppRoute =
  | { name: 'home' }
  | { name: 'latest' }
  | { name: 'post'; id: string }
  | { name: 'my-mogs' }
  | { name: 'my-upmogs' };

const POST_ID = /^[A-Za-z0-9_-]{8,32}$/;
export const ROUTE_HASH = /^(#\/?)?$|^#\/(mogs|my-mogs|my-upmogs)$|^#\/mogs\/[A-Za-z0-9_-]{8,32}$/;

export function parseRoute(hash: string): AppRoute {
  const path = hash.replace(/^#\/?/, '');
  if (path === 'mogs') return { name: 'latest' };
  if (path === 'my-mogs') return { name: 'my-mogs' };
  if (path === 'my-upmogs') return { name: 'my-upmogs' };
  const match = /^mogs\/(.+)$/.exec(path);
  if (match && POST_ID.test(match[1])) return { name: 'post', id: match[1] };
  return { name: 'home' };
}

export function routeToHash(route: AppRoute): string {
  switch (route.name) {
    case 'latest': return '#/mogs';
    case 'post': return `#/mogs/${route.id}`;
    case 'my-mogs': return '#/my-mogs';
    case 'my-upmogs': return '#/my-upmogs';
    default: return '';
  }
}

const embedded = (() => { try { return window.parent !== window; } catch { return true; } })();

function parentHash(): string | null {
  try { return window.parent.location.hash; } catch { return null; } // same-origin wrapper only
}

/** Canonical outer URL for sharing; never the inner /mog-scan/ page or a preview host. */
export function shareUrl(route: AppRoute): string {
  const configured = import.meta.env.VITE_PUBLIC_APP_URL as string | undefined;
  let base = configured?.trim();
  if (!base) {
    if (embedded) {
      try { base = `${window.parent.location.origin}${window.parent.location.pathname}`; } catch { base = `${window.location.origin}/`; }
    } else {
      base = `${window.location.origin}${window.location.pathname}`;
    }
  }
  return `${base.replace(/#.*$/, '')}${routeToHash(route)}`;
}

type BridgeMessage = { type: 'mog:navigate' | 'mog:route' | 'mog:ready'; hash?: string };

export function useAppRoute() {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute((embedded ? parentHash() : null) ?? window.location.hash));
  const currentHash = useRef(routeToHash(route));

  const apply = useCallback((hash: string) => {
    if (!ROUTE_HASH.test(hash)) return;
    const next = parseRoute(hash);
    const normalized = routeToHash(next);
    if (normalized === currentHash.current) return; // ignore unchanged routes (no echo loops)
    currentHash.current = normalized;
    setRoute(next);
  }, []);

  useEffect(() => {
    if (!embedded) {
      const onHash = () => apply(window.location.hash);
      window.addEventListener('hashchange', onHash);
      return () => window.removeEventListener('hashchange', onHash);
    }
    const onMessage = (event: MessageEvent<BridgeMessage>) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || data.type !== 'mog:navigate' || typeof data.hash !== 'string') return;
      apply(data.hash);
    };
    window.addEventListener('message', onMessage);
    // Tell the wrapper we're ready so it resends the current route (load timing).
    window.parent.postMessage({ type: 'mog:ready' } satisfies BridgeMessage, window.location.origin);
    return () => window.removeEventListener('message', onMessage);
  }, [apply]);

  const navigate = useCallback((next: AppRoute) => {
    const hash = routeToHash(next);
    if (hash === currentHash.current) return;
    if (!embedded) {
      if (hash) window.location.hash = hash;
      else history.pushState(null, '', `${window.location.pathname}${window.location.search}`);
      currentHash.current = hash;
      setRoute(next);
      return;
    }
    currentHash.current = hash;
    setRoute(next);
    window.parent.postMessage({ type: 'mog:route', hash } satisfies BridgeMessage, window.location.origin);
  }, []);

  // Standalone back-to-home via pushState doesn't fire hashchange; handle popstate too.
  useEffect(() => {
    if (embedded) return;
    const onPop = () => apply(window.location.hash);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [apply]);

  return { route, navigate, embedded };
}
