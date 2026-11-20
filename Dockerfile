# FastVideoDown API on Hugging Face Spaces (Docker)
# Runs the same Express + yt-dlp + ffmpeg backend as Cloady/Render,
# but on HF's free tier (2 vCPU, 16 GB RAM, no card).
# Hugging Face Spaces expects the app on port 7860.
FROM node:20-slim

# Tools needed by the fetch scripts (curl, tar, xz) + certificates.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates xz-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# App code + fetch scripts.
COPY package.json server.js fetch-ytdlp.sh fetch-ffmpeg.sh ./
RUN chmod +x fetch-ytdlp.sh fetch-ffmpeg.sh

# Node dependencies (express, undici).
RUN npm install --no-audit --no-fund

# yt-dlp binary + static ffmpeg (downloaded fresh at build time;
# the repo does not store the binaries).
RUN bash fetch-ytdlp.sh && bash fetch-ffmpeg.sh

# Hugging Face Spaces serves the container on port 7860.
ENV PORT=7860
EXPOSE 7860

CMD ["node", "server.js"]
