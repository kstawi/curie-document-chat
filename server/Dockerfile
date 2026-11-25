# Build context is the repository root (npm workspaces share one lockfile).
FROM node:22.23.5-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci --no-audit --no-fund

# Used by `docker compose run --rm test`: lint, type checks and tests over the whole repo.
FROM deps AS test
COPY . .
CMD ["npm", "run", "check"]

FROM deps AS build
COPY tsconfig.base.json ./
COPY server server
RUN npm run build -w server

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json server/
# Optional packages left out: pdf.js's native canvas, which draws pages (reading text doesn't need it), BullMQ's
# native message packing (it falls back to plain JavaScript) and pg's Cloudflare socket support.
RUN npm ci --omit=dev --omit=optional --workspace server --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/server/dist server/dist
WORKDIR /app/server
USER node
CMD ["node", "dist/api.js"]
