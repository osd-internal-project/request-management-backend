# Build from the repo root so every workspace manifest is in the context:
#   docker build -t request-management/external-service -f services/external-service/Dockerfile .

FROM node:22-alpine AS builder
WORKDIR /app

# yarn needs every workspace manifest present before it can link them.
COPY package.json yarn.lock ./
COPY libs/prisma/package.json ./libs/prisma/
COPY libs/share/package.json ./libs/share/
COPY services/user-service/package.json ./services/user-service/
COPY services/core-service/package.json ./services/core-service/
COPY services/external-service/package.json ./services/external-service/
COPY libs/prisma/schema.prisma ./libs/prisma/
RUN yarn install --frozen-lockfile

COPY tsconfig.base.json ./
# Both services' nest-cli.json point at ../../webpack.config.js.
COPY webpack.config.js ./
COPY libs ./libs
# core-service's SOURCE, not just its manifest. This service runs the same
# domain providers in its own process and consumes them as TypeScript — see
# services/core-service/src/index.ts. Without this the build cannot resolve
# @request-management/core-service.
COPY services/core-service ./services/core-service
COPY services/external-service ./services/external-service

# webpack.config.js aliases both @request-management/share and
# @request-management/core-service to their src and bundles them into
# dist/main.js, so this one command produces everything the runner needs.
# Neither has a build script and neither has a dist to copy.
RUN yarn build:external-service

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json yarn.lock ./
COPY libs/prisma/package.json ./libs/prisma/
COPY libs/share/package.json ./libs/share/
COPY services/user-service/package.json ./services/user-service/
COPY services/core-service/package.json ./services/core-service/
COPY services/external-service/package.json ./services/external-service/
COPY libs/prisma/schema.prisma ./libs/prisma/
RUN yarn install --production --frozen-lockfile

COPY --from=builder /app/services/external-service/dist ./services/external-service/dist

EXPOSE 3003
CMD ["node", "services/external-service/dist/main"]
