
FROM node:22-alpine AS build
WORKDIR /app


COPY package.json package-lock.json ./
RUN npm ci


COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production


COPY package.json package-lock.json ./
RUN npm ci --omit=dev


COPY --from=build /app/src ./src
COPY --from=build /app/prisma ./prisma


USER node


CMD ["node", "src/server.js"]