FROM mcr.microsoft.com/playwright:v1.50.1-noble

WORKDIR /app

# Set Sri Lanka timezone by default
ENV TZ=Asia/Colombo
ENV HEADLESS=true
ENV NODE_ENV=production

# Install dependencies first for layer caching
COPY package*.json ./
RUN npm ci

# Copy application source
COPY tsconfig.json ./
COPY src ./src

# Ensure persistent directories exist
RUN mkdir -p /app/data /app/.auth /app/debug-dump

CMD ["npm", "start"]
