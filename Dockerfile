# Image unique : API + interface web compilée.
FROM node:24-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:24-alpine AS server
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production WEB_DIST=/app/web/dist
WORKDIR /app/server
COPY --from=server /app/server/node_modules ./node_modules
COPY --from=server /app/server/dist ./dist
COPY --from=server /app/server/package.json ./
COPY --from=web /app/web/dist /app/web/dist
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
