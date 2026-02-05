FROM node:20-alpine

# Install system dependencies for Tesseract.js
RUN apk add --no-cache \
    python3 \
    py3-pip \
    curl \
    wget \
    bash \
    git

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Pre-download Tesseract.js models to speed up initialization
RUN npm install --prefix /tmp tesseract.js@7.0.0 && \
    node -e "const Tesseract = require('/tmp/node_modules/tesseract.js'); Tesseract.createWorker('eng').then(w => { console.log('Models cached'); w.terminate(); });" || echo "Model pre-download failed, will download on first use"

# Copy source code
COPY . .

# Create required directories
RUN mkdir -p uploads/verified uploads/pending uploads/rejected test-results

# Set proper permissions
RUN chmod -R 755 uploads test-results

# Expose port
EXPOSE 3000

# Health check with longer start period for Tesseract initialization
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start the service
CMD ["node", "src/index.js"]
