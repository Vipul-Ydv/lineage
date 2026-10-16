FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci
COPY . .
RUN cd web && npm run build
ENV PORT=80
# Load (or refresh) the graph from the data snapshot, then serve.
CMD ["sh", "-c", "node --import tsx src/graph/load.ts && node --import tsx src/server.ts"]
