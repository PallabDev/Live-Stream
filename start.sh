#!/bin/bash

# Run database migrations for schema updates
echo "Running SQLite database migrations..."
npm run db:migrate || true

# Start the primary Node.js application
echo "Starting CoWatch Node.js application..."
npm start
