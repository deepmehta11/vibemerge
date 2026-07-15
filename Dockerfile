FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.test.json ./
COPY src ./src
COPY harness ./harness
COPY config ./config
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY harness ./harness
COPY config ./config
RUN mkdir -p /app/data && chown -R node:node /app

# Railway mounts persistent volumes as root. Initialize the mount as root, then
# immediately drop privileges for the long-running controller process.
USER root
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "const port = process.env.PORT || '3000'; fetch('http://127.0.0.1:' + port + '/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["sh", "-c", "chown -R node:node /app/data && exec runuser -u node -- node dist/serve.js"]
