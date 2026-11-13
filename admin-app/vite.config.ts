import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'

// In development, proxy the admin app's same-origin paths to PCS / the scheduler
// so internal addresses never end up in the UI defaults. Ports must match the
// local forward; when tunneling to a remote host with ssh -L, change them here
// instead of the connection settings in the UI.
// Targets come from the shell environment or .env.local (loadEnv is required to
// read .env.local; process.env does not see the .env files Vite loads).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const PCS_TARGET = env.VITE_PCS_TARGET || 'http://127.0.0.1:7901'
  // The scheduler is deployed as a container and listens on 8443 inside it
  // (the host maps the same port).
  const SCHEDULER_TARGET = env.VITE_SCHEDULER_TARGET || 'http://127.0.0.1:8443'
  // Used by the dev proxy only: the browser never holds the admin token.
  // The token comes from the shell environment or .env.local (gitignored via *.local).
  const adminToken = (env.PCS_ADMIN_TOKEN ?? '').trim()
  const injectToken: Pick<ProxyOptions, 'configure'> = {
    configure(proxy) {
      proxy.on('proxyReq', (proxyReq) => {
        if (adminToken && !proxyReq.getHeader('authorization')) {
          proxyReq.setHeader('authorization', `Bearer ${adminToken}`)
        }
      })
    },
  }

  return {
  plugins: [react()],
  server: {
    proxy: {
      // The proxy prefix must not collide with frontend routes: the SPA has its
      // own /scheduler page. Using /scheduler as an API prefix would forward a
      // refresh request for that page to the scheduler and return
      // {"code":"ROUTE_NOT_FOUND"} instead of index.html.
      '/api/pcs': {
        target: PCS_TARGET,
        changeOrigin: true,
        // The interactive terminal uses WebSocket: upgrade requests go through
        // this same proxy and rewrite.
        ws: true,
        rewrite: (path) => path.replace(/^\/api\/pcs/, ''),
        ...injectToken,
      },
      '/api/scheduler': {
        target: SCHEDULER_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/scheduler/, ''),
      },
      // The old /pcs does not conflict and is kept for saved connection configs.
      '/pcs': {
        target: PCS_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/pcs/, ''),
        ...injectToken,
      },
    },
  },
  }
})
