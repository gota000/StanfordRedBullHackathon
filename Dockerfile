FROM node:20-slim

WORKDIR /app

# Install production deps first for better layer caching.
# package-lock.json is present, so use `npm ci` for reproducible builds.
COPY package*.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# Cloud Run provides PORT (defaults to 8080); the server reads process.env.PORT.
ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.js"]
