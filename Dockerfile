FROM node:22-alpine

WORKDIR /app

# Install lightweight system Chromium and fonts on Alpine
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    tzdata

# Set Sri Lanka timezone and point Playwright to Alpine's native Chromium binary
ENV TZ=Asia/Colombo
ENV HEADLESS=true
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# 1. Install all dependencies (including devDependencies for TypeScript build)
COPY package*.json ./
RUN npm ci

# 2. Copy source and compile TypeScript -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 3. Remove devDependencies (tsx, typescript, @types/*) and run compiled JS in production
RUN npm prune --omit=dev
ENV NODE_ENV=production

# Ensure persistent directories exist
RUN mkdir -p /app/data /app/.auth /app/debug-dump

CMD ["node", "dist/index.js"]
