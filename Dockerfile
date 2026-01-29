# Stage 1: Build frontend
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# Stage 2: Build backend with native dependencies
FROM node:20-alpine AS backend-builder

# Install build tools for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app/backend
COPY backend/package*.json ./

# Install ALL dependencies (need devDeps for any build scripts)
RUN npm ci

# Stage 3: Production image
FROM node:20-alpine AS production

# Install runtime dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy backend dependencies and rebuild native modules for this exact image
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --only=production

# Copy backend source
COPY backend/*.js ./backend/

# Copy frontend build output
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Set production environment
ENV NODE_ENV=production

WORKDIR /app/backend

EXPOSE 3000

CMD ["node", "server.js"]
