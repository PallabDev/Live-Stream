#!/bin/bash

# Start MediaMTX in the background
echo "Starting MediaMTX..."
/usr/local/bin/mediamtx /app/mediamtx.yml &

# Start the primary Node.js application
echo "Starting CoWatch Node.js application..."
npm start
