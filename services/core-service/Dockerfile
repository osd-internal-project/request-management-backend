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
COPY services/run-number-service/package.json ./services/run-number-service/
COPY services/external-service/package.json ./services/external-service/
COPY libs/prisma/schema.prisma ./libs/prisma/
RUN yarn install --frozen-lockfile

COPY tsconfig.base.json ./
# Both services' nest-cli.json point at ../../webpack.config.js.
COPY webpack.config.js ./
COPY libs ./libs
COPY services/core-service ./services/core-service

# webpack.config.js aliases @request-management/share to libs/share/src and
# bundles it into dist/main.js, so this one command produces everything the
# runner needs. libs/share has no build script and no dist to copy.
RUN yarn build:core-service

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json yarn.lock ./
COPY libs/prisma/package.json ./libs/prisma/
COPY libs/share/package.json ./libs/share/
COPY services/user-service/package.json ./services/user-service/
COPY services/core-service/package.json ./services/core-service/
COPY services/run-number-service/package.json ./services/run-number-service/
COPY services/external-service/package.json ./services/external-service/
COPY libs/prisma/schema.prisma ./libs/prisma/
RUN yarn install --production --frozen-lockfile

COPY --from=builder /app/services/core-service/dist ./services/core-service/dist



EXPOSE 3002
CMD ["node", "services/core-service/dist/main"]
