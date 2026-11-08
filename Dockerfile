FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig*.json vite.config.ts ./
RUN npm install --no-audit --no-fund
COPY server ./server
COPY web ./web
COPY tests ./tests
COPY scripts ./scripts
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/tsconfig.server.json ./tsconfig.server.json
COPY --from=build /app/server/src ./server/src
COPY --from=build /app/tests ./tests
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/web/dist ./web/dist
COPY server/sql ./server/sql
COPY package.json ./package.json
EXPOSE 3000
CMD ["node", "dist/server/src/index.js"]
