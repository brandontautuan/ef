import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Public same-origin API routes -> FastAPI routes. The production Zo Space
// proxies implement this same allowlisted mapping; this dev proxy mirrors it so
// the anonymous session cookie is first-party in development too.
//   /api/mog/posts...  -> /v1/social/posts...
//   /api/mog/me/...    -> /v1/social/me/...
//   /api/mog/comments/... -> /v1/social/comments/...
//   /api/mog/<other>   -> /v1/<other>   (session, scans, leaderboard)
export function rewriteMogApiPath(path: string) {
  return path
    .replace(/^\/api\/mog\/(posts|me|comments)(?=\/|\?|$)/, '/v1/social/$1')
    .replace(/^\/api\/mog(?=\/|\?|$)/, '/v1');
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.MOG_API_PROXY_TARGET || 'http://127.0.0.1:8000';
  return {
    plugins: [react()],
    server: {
      proxy: {
        // changeOrigin stays false so the service sees the browser's real Origin.
        '/api/mog': { target, rewrite: rewriteMogApiPath },
      },
    },
    preview: {
      proxy: {
        '/api/mog': { target, rewrite: rewriteMogApiPath },
      },
    },
  };
});
