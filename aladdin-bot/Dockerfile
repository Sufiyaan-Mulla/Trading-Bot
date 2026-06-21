FROM node:20-alpine

# Metadata
LABEL maintainer="Aladdin Bot"
LABEL description="Aladdin Trading Bot V7"

# Create non-root user
RUN addgroup -S aladdin && adduser -S aladdin -G aladdin

WORKDIR /app

# Install dependencies first (layer-cache friendly)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy source
COPY --chown=aladdin:aladdin . .

# Create required runtime directories
RUN mkdir -p trade_logs config backups \
    && chown -R aladdin:aladdin trade_logs config backups

# Drop root
USER aladdin

# Health check via metrics-server /health endpoint (port 9090)
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

# Expose dashboard and metrics ports
EXPOSE 3000 8080 9090

# Default: start trading engine
CMD ["node", "startup.js"]
