FROM node:20-slim

# Install ffmpeg and build dependencies for native node-modules compile (better-sqlite3)
RUN apt-get update && \
    apt-get install -y ffmpeg python3 make g++ && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install MediaMTX
ADD https://github.com/bluenviron/mediamtx/releases/download/v1.19.2/mediamtx_v1.19.2_linux_amd64.tar.gz /tmp/mediamtx.tar.gz
RUN tar -xzf /tmp/mediamtx.tar.gz -C /usr/local/bin/ mediamtx && rm /tmp/mediamtx.tar.gz

WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install dependencies
RUN npm ci --legacy-peer-deps

# Copy workspace source code
COPY . .

# Fix script line endings and permissions
RUN sed -i 's/\r$//' /app/start.sh && chmod +x /app/start.sh

# Create volume target for streams media HLS chunks
RUN mkdir -p /app/media

# Expose HTTP port, WHIP signaling port, and WebRTC media ports
EXPOSE 5678 8889 8189 8189/udp

# Start application using the startup wrapper script
CMD ["/app/start.sh"]
