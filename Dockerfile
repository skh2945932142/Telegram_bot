FROM node:22-bookworm-slim AS deps

WORKDIR /app

COPY my-telegram-bot/package.json my-telegram-bot/package-lock.json ./
RUN npm ci

FROM deps AS verify

COPY my-telegram-bot/ ./
RUN npm test
RUN npm run typecheck

FROM node:22-bookworm-slim AS prod-deps

WORKDIR /app

COPY my-telegram-bot/package.json my-telegram-bot/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY --from=prod-deps /app/node_modules ./node_modules
COPY my-telegram-bot/package.json ./
COPY my-telegram-bot/index.js ./
COPY my-telegram-bot/knowledge ./knowledge
COPY my-telegram-bot/src ./src

EXPOSE 8080

CMD ["npm", "start"]
