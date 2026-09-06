# ===================================================
# Stage 1: Build & Dependencies
# ===================================================
FROM node:24-alpine AS builder

WORKDIR /app

# Install pnpm via corepack
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package manifests
COPY package.json pnpm-lock.yaml ./

# Install only production dependencies
RUN pnpm install --frozen-lockfile --prod

# ===================================================
# Stage 2: Production Runtime
# ===================================================
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3005

# Create and use non-root user for security
USER node

# Copy dependencies from builder
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node package.json ./

# Copy application source code & public static assets
COPY --chown=node:node src/ ./src/
COPY --chown=node:node public/ ./public/

# Expose server port
EXPOSE 3005

# Start production server
CMD ["node", "src/app/server.js"]
