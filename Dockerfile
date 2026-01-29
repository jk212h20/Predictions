# Stage 1: Build frontend
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# Stage 2: Build backend with native dependencies
FROM node:20-alpine AS backend-builder

# Install build tools for better-sqlite3 (only needed in this stage)
RUN apk add --no-cache python3 make g++

WORKDIR /app/backend
COPY backend/package*.json ./

# Install production dependencies only (native modules compiled here)
RUN npm ci --omit=dev

# Stage 3: Slim production image (NO build tools needed)
FROM node:20-alpine AS production

WORKDIR /app

# Copy pre-built backend with native modules from builder stage
COPY --from=backend-builder /app/backend/node_modules ./backend/node_modules
COPY backend/package*.json ./backend/

# Copy backend source
COPY backend/*.js ./backend/

# Copy research data needed for seeding
COPY research/attendance_likelihood.csv ./research/

# Copy frontend build output
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Set production environment
ENV NODE_ENV=production

WORKDIR /app/backend

EXPOSE 3000

CMD ["node", "server.js"]
