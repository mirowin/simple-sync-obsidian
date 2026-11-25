FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.mjs viewer.mjs ./
RUN mkdir -p /data && chown -R node:node /data /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8787
VOLUME ["/data"]
EXPOSE 8787
USER node
CMD ["node", "server.mjs"]
