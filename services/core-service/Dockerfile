# Build from the repo root so every workspace manifest is in the context:
#   docker build -t request-management/core-service -f services/core-service/Dockerfile .

FROM node:22-alpine AS builder
WORKDIR /app

# yarn needs every workspace manifest present before it can link them.
COPY package.json yarn.lock ./
COPY libs/prisma/package.json ./libs/prisma/
COPY libs/share/package.json ./libs/share/
COPY services/user-service/package.json ./services/user-service/
COPY services/core-service/package.json ./services/core-service/
COPY libs/prisma/schema.prisma ./libs/prisma/
RUN yarn install --frozen-lockfile

COPY tsconfig.base.json ./
COPY libs ./libs
COPY services/core-service ./services/core-service

# libs/share must be compiled before the service that consumes its dist.
RUN yarn build:core-service

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json yarn.lock ./
COPY libs/prisma/package.json ./libs/prisma/
COPY libs/share/package.json ./libs/share/
COPY services/user-service/package.json ./services/user-service/
COPY services/core-service/package.json ./services/core-service/
COPY libs/prisma/schema.prisma ./libs/prisma/
RUN yarn install --production --frozen-lockfile

COPY --from=builder /app/libs/share/dist ./libs/share/dist
COPY --from=builder /app/services/core-service/dist ./services/core-service/dist

EXPOSE 3002
CMD ["node", "services/core-service/dist/main"]
