FROM node:22-bookworm-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS verify

COPY . .
RUN npm test
RUN npm run typecheck

FROM node:22-bookworm-slim AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY index.js ./
COPY yuno_diary.json ./
COPY knowledge ./knowledge
COPY public ./public
COPY src ./src

EXPOSE 8080

CMD ["npm", "start"]
