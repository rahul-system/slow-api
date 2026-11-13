FROM node:20-alpine

WORKDIR /app

# No runtime dependencies — package.json is copied for engines/start script only.
COPY package.json ./
COPY server.js ./

ENV PORT=3000
EXPOSE 3000

USER node

CMD ["node", "server.js"]
