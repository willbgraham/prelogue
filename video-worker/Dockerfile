FROM node:22-slim

# ffmpeg (existing assemble path) + headless-Chrome runtime deps for Remotion.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 \
    libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
    libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src/ ./src/
COPY remotion/ ./remotion/

# Pre-download the Remotion Headless Shell so the first render doesn't stall.
RUN npx remotion browser ensure

# Chrome-in-container hardening is passed via chromiumOptions in renderScene.js
# (swiftshader GL, headless). Host should be >= 2 vCPU / 2-4 GB for Remotion.
EXPOSE 3000
CMD ["node", "src/index.js"]
