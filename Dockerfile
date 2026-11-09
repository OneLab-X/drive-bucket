# syntax=docker/dockerfile:1.7
# drivebucket-server: read proxy (+ S3 API from M3) for Google Drive.
#   docker build -t drivebucket .
#   docker run -p 8080:8080 --env-file .env drivebucket

FROM node:26-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY packages/server packages/server
RUN pnpm --filter "@drivebucket/server..." build \
 && pnpm --filter @drivebucket/server deploy --prod /out

FROM node:26-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DRIVEBUCKET_RESIZE_CACHE_DIR=/var/cache/drivebucket
WORKDIR /app
COPY --from=build /out ./
RUN mkdir -p /var/cache/drivebucket && chown node:node /var/cache/drivebucket
USER node
EXPOSE 8080
VOLUME ["/var/cache/drivebucket"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/-/healthy').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/bin.js"]
