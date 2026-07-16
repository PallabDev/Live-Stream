FROM node:20-slim

# Install ffmpeg and build dependencies for native node-modules compile (better-sqlite3)
RUN apt-get update && \
    apt-get install -y ffmpeg python3 make g++ && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

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

# Expose HTTP port and RTMP port
EXPOSE 5678 1935

# Start application using the startup wrapper script
CMD ["/app/start.sh"]
