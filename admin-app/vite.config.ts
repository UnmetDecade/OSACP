import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'

// In development, proxy the admin app's same-origin paths to the local PCS / scheduler so internal addresses are not hardcoded as UI defaults.
// Ports must match the local forwarding; when using ssh -L to a remote machine, change them here instead of the UI connection config.
const PCS_TARGET = process.env.VITE_PCS_TARGET ?? 'http://127.0.0.1:7901'
// The scheduler is deployed as a container listening on 8443 inside it (the host maps the same port).
const SCHEDULER_TARGET = process.env.VITE_SCHEDULER_TARGET ?? 'http://127.0.0.1:8443'

export default defineConfig(({ mode }) => {
  // Used only by the dev proxy: the browser does not need to hold the admin token.
  // The token comes from the shell environment or .env.local (already covered by .gitignore's *.local).
  const adminToken = (loadEnv(mode, process.cwd(), '').PCS_ADMIN_TOKEN ?? '').trim()
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
      // The proxy prefix must not collide with frontend routes: the SPA has its own /scheduler page, and
      // using /scheduler as the API prefix makes a refresh of that page forward the navigation request to the scheduler,
      // returning {"code":"ROUTE_NOT_FOUND"} instead of index.html.
      '/api/pcs': {
        target: PCS_TARGET,
        changeOrigin: true,
        // The interactive terminal is a WebSocket: upgrade requests go through the same proxy and rewrite.
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
