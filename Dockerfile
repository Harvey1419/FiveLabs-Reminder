# Build the workspace contracts and the selected strict TypeScript runtime.
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY packages/ ./packages/
RUN pnpm install --frozen-lockfile
COPY src/ ./src/
COPY scripts/checks/compiled-runtime-graph.ts ./scripts/checks/compiled-runtime-graph.ts
RUN pnpm run build:packages

# Resolve production dependencies without shipping the compiler or dev workspace links.
FROM node:22-alpine AS dependencies
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
RUN pnpm install --frozen-lockfile --prod

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3005
ENV NODE_OPTIONS="--max-old-space-size=96"
COPY --chown=node:node --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist/runtime ./dist/runtime
COPY --chown=node:node package.json ./
COPY --chown=node:node public/ ./public/
COPY --chown=node:node config/ ./config/
COPY --chown=node:node --from=builder /app/packages/contracts/dist ./packages/contracts/dist
COPY --chown=node:node --from=builder /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --chown=node:node --from=builder /app/packages/ai/dist ./packages/ai/dist
COPY --chown=node:node --from=builder /app/packages/ai/package.json ./packages/ai/package.json
COPY --chown=node:node --from=builder /app/packages/tools/dist ./packages/tools/dist
COPY --chown=node:node --from=builder /app/packages/tools/package.json ./packages/tools/package.json
COPY --chown=node:node --from=builder /app/packages/agent-core/dist ./packages/agent-core/dist
COPY --chown=node:node --from=builder /app/packages/agent-core/package.json ./packages/agent-core/package.json
USER node
EXPOSE 3005
CMD ["node", "dist/runtime/app/server.js"]
