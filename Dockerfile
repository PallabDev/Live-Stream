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
RUN npm ci

# Copy workspace source code
COPY . .

# Create volume target for streams media HLS chunks
RUN mkdir -p /app/media

# Expose default port
EXPOSE 5678

# Start application using tsx watch or tsx
CMD ["npm", "start"]
