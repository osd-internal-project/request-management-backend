# Build from the repo root so every workspace manifest is in the context:
#   docker build -t request-management/user-service -f services/user-service/Dockerfile .

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
# Both services' nest-cli.json point at ../../webpack.config.js.
COPY webpack.config.js ./
COPY libs ./libs
COPY services/user-service ./services/user-service

# webpack.config.js aliases @request-management/share to libs/share/src and bundles it
# into dist/main.js, so this one command produces everything the runner needs.
RUN yarn build:user-service

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

COPY --from=builder /app/services/user-service/dist ./services/user-service/dist

EXPOSE 3001
CMD ["node", "services/user-service/dist/main"]
