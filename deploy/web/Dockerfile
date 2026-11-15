# platform/web:demo
#
# Static admin app plus same-origin proxies to PCS and the scheduler, mirroring
# admin-app/vite.config.ts. Authentication is the PCS session cookie, passed
# through unchanged; the browser never holds a shared token.
#
# The build context is the repository root:
#   docker build -f deploy/web/Dockerfile -t platform/web:demo .

# Optional registry prefix for networks where Docker Hub is unreachable.
ARG REGISTRY=

FROM ${REGISTRY}node:22-alpine AS build
WORKDIR /app
COPY admin-app/package.json admin-app/package-lock.json ./
RUN npm ci --loglevel=http
COPY admin-app ./
RUN npm run build

FROM ${REGISTRY}nginx:1.27-alpine

COPY deploy/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
