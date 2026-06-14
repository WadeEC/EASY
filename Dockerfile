# Multi-stage build: small final image, native better-sqlite3 compiled correctly.
# Works on Render, Railway, Fly.io, any container host.

FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*

# ---- dependencies ----
FROM base AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund

# ---- build ----
FROM base AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Persist league.db on a mounted volume at /data
ENV LEAGUE_DB=/data/league.db

# Pull only what the standalone server needs
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# better-sqlite3 native binding lives in node_modules — standalone copies it
# but we keep the build deps out of the runtime image.

RUN useradd -u 1001 -m nextjs && mkdir -p /data && chown -R nextjs:nextjs /data /app
USER nextjs
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
