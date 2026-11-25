# Build context is the repository root (npm workspaces share one lockfile).
FROM node:22.23.5-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --workspace web --no-audit --no-fund
COPY tsconfig.base.json ./
COPY web web
RUN npm run build -w web

# An unprivileged nginx: the built app, and /api passed on to the API, so the browser sees one origin.
FROM nginxinc/nginx-unprivileged:1.30.6-alpine AS runtime
COPY web/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 8080
