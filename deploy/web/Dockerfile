# platform/web:demo
#
# Static admin app plus same-origin proxies to PCS and the scheduler, mirroring
# admin-app/vite.config.ts. nginx injects the demo admin token server-side, so the
# browser never holds it.
#
# The build context is the repository root:
#   docker build -f deploy/web/Dockerfile -t platform/web:demo .

FROM node:22-alpine AS build
WORKDIR /app
COPY admin-app/package.json admin-app/package-lock.json ./
RUN npm ci
COPY admin-app ./
RUN npm run build

FROM nginx:1.27-alpine

COPY deploy/web/nginx.conf.template /etc/nginx/demo/default.conf.template
COPY deploy/web/40-demo-token.sh /docker-entrypoint.d/40-demo-token.sh
RUN chmod 0755 /docker-entrypoint.d/40-demo-token.sh

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
