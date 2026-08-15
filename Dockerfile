FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
# the shipped default calendar; the runtime data dir overlays it on a volume
COPY data/calendar.json ./data/calendar.json
EXPOSE 3001
CMD ["node", "server/index.js"]
