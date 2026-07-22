#!/bin/bash

# Run database schema push & migrations for schema updates
echo "Running SQLite database migrations..."
npx drizzle-kit push --force || true
npm run db:migrate || true

# Seed default admin account if not present
echo "Seeding default admin account..."
npx tsx src/app/common/database/seed-admin.ts || true

# Start the primary Node.js application
echo "Starting CoWatch Node.js application..."
npm start
