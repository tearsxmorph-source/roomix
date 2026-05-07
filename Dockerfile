FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app

COPY prisma ./prisma
COPY src ./src
COPY public ./public

RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/public ./public
COPY prisma ./prisma
COPY server.js ./server.js

EXPOSE 3000
CMD ["node", "server.js"]
