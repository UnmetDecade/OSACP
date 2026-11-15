# platform/pcs:demo
#
# PCS control plane for the single-machine demo. The server runs from TypeScript
# sources via tsx, so devDependencies are installed on purpose.
#
# The build context is the repository root:
#   docker build -f deploy/pcs/Dockerfile -t platform/pcs:demo .

# Optional registry prefix for networks where Docker Hub is unreachable.
ARG REGISTRY=
FROM ${REGISTRY}node:22-bookworm-slim

WORKDIR /app

COPY pcs-issuer/package.json pcs-issuer/package-lock.json ./
RUN npm ci --loglevel=http

COPY pcs-issuer ./
COPY deploy/pcs/entrypoint.sh /usr/local/bin/pcs-entrypoint
RUN chmod 0755 /usr/local/bin/pcs-entrypoint \
 && mkdir -p /app/keys /run/demo

EXPOSE 7901
ENTRYPOINT ["/usr/local/bin/pcs-entrypoint"]
