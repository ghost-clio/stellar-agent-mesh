FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY gateway/package*.json ./gateway/
RUN cd gateway && npm ci --production=false

# Copy source
COPY gateway/ ./gateway/

# Compile TypeScript
RUN cd gateway && npx tsc

# Copy skill + contracts for reference
COPY skill/ ./skill/
COPY contracts/ ./contracts/
COPY README.md .

ENV PORT=3402
EXPOSE 3402

CMD ["node", "gateway/dist/index.js"]
