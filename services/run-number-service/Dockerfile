# Build from the repo root so every workspace manifest is in the context:
#   docker build -t request-management/run-number-service -f services/run-number-service/Dockerfile .

FROM node:22-alpine AS builder
WORKDIR /app

# yarn needs every workspace manifest present before it can link them.
COPY package.json yarn.lock ./
COPY libs/prisma/package.json ./libs/prisma/
COPY libs/share/package.json ./libs/share/
COPY services/user-service/package.json ./services/user-service/
COPY services/core-service/package.json ./services/core-service/
COPY services/external-service/package.json ./services/external-service/
COPY services/run-number-service/package.json ./services/run-number-service/
COPY libs/prisma/schema.prisma ./libs/prisma/
RUN yarn install --frozen-lockfile

COPY tsconfig.base.json ./
# ทุก service ชี้ nest-cli.json ไปที่ ../../webpack.config.js ตัวเดียวกัน.
COPY webpack.config.js ./
COPY libs ./libs
# core-service's SOURCE, not just its manifest — this service imports its
# PrincipalModule/RemotePrincipalGuard as TypeScript, the same way
# external-service does. Without it the build cannot resolve
# @request-management/core-service.
COPY services/core-service ./services/core-service
COPY services/run-number-service ./services/run-number-service

# webpack.config.js aliases @request-management/share and
# @request-management/core-service to their src and bundles them into
# dist/main.js, so this one command produces everything the runner needs.
# Neither has a build script and neither has a dist to copy.
RUN yarn build:run-number-service

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json yarn.lock ./
COPY libs/prisma/package.json ./libs/prisma/
COPY libs/share/package.json ./libs/share/
COPY services/user-service/package.json ./services/user-service/
COPY services/core-service/package.json ./services/core-service/
COPY services/external-service/package.json ./services/external-service/
COPY services/run-number-service/package.json ./services/run-number-service/
COPY libs/prisma/schema.prisma ./libs/prisma/
RUN yarn install --production --frozen-lockfile

COPY --from=builder /app/services/run-number-service/dist ./services/run-number-service/dist

EXPOSE 3004
CMD ["node", "services/run-number-service/dist/main"]
