FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server ./server
COPY status-monitor-web ./status-monitor-web
COPY dashboard ./dashboard

RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production
EXPOSE 3899 8080

USER node
CMD ["node", "status-monitor-web/server.js"]
