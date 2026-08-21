# ============================================================
# NewsMate Production Dockerfile
# Multi-stage Node.js container with Playwright headless support
# ============================================================

FROM node:20-bookworm-slim

# Install system dependencies for Playwright headless chromium
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    libnss3 \
    libasound2 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libgbm1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Install Playwright browser binaries
RUN npx playwright install chromium --with-deps

# Copy application source code
COPY . .

# Environment Defaults
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Start the NewsMate production server
CMD ["npm", "start"]
