import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'

// 开发时把管理应用的同源路径代理到本地 PCS / 调度机，避免把内网地址写进界面默认值。
// 端口要和本机转发一致；用 ssh -L 指向远端时在这里改，不用动界面里的连接配置。
const PCS_TARGET = process.env.VITE_PCS_TARGET ?? 'http://127.0.0.1:7901'
// 调度机以容器形式部署，容器内监听 8443（宿主机映射同端口）。
const SCHEDULER_TARGET = process.env.VITE_SCHEDULER_TARGET ?? 'http://127.0.0.1:8443'

export default defineConfig(({ mode }) => {
  // 仅开发代理使用：浏览器不需要持有管理员令牌。
  // 令牌来自 shell 环境或 .env.local（已被 .gitignore 的 *.local 覆盖）。
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
      // 代理前缀必须和前端路由错开：SPA 自己有 /scheduler 页面，
      // 再用 /scheduler 做 API 前缀时，刷新该页面会把导航请求转发给调度机，
      // 拿到 {"code":"ROUTE_NOT_FOUND"} 而不是 index.html。
      '/api/pcs': {
        target: PCS_TARGET,
        changeOrigin: true,
        // 交互式终端是 WebSocket：升级请求同样走这条代理和 rewrite。
        ws: true,
        rewrite: (path) => path.replace(/^\/api\/pcs/, ''),
        ...injectToken,
      },
      '/api/scheduler': {
        target: SCHEDULER_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/scheduler/, ''),
      },
      // 旧的 /pcs 不冲突，保留给已保存的连接配置。
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
