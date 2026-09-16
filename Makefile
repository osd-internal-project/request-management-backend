.PHONY: default install generate build build-user build-core build-external \
        dev-user dev-core dev-external migrate deploy status reset lint test clean help

default: install generate

## install     — ติดตั้ง dependency ทุก workspace (postinstall จะรัน prisma generate ให้)
install:
	yarn install --frozen-lockfile

## generate    — สร้าง Prisma Client ใหม่จาก libs/prisma/schema.prisma
generate:
	yarn prisma:generate

## build       — build libs/share แล้วตามด้วย service ทั้งสาม
build: generate
	yarn build:services

## build-user  — build libs/share แล้วตามด้วย user-service
build-user: generate
	yarn build:user-service

## build-core  — build libs/share แล้วตามด้วย core-service
build-core: generate
	yarn build:core-service

## build-external — build libs/share แล้วตามด้วย external-service
build-external: generate
	yarn build:external-service

## dev-user    — รัน user-service โหมด watch (port 3001)
dev-user: generate
	yarn start:user-service:dev

## dev-core    — รัน core-service โหมด watch (port 3002)
dev-core: generate
	yarn start:core-service:dev

## dev-external — รัน external-service โหมด watch (port 3003)
dev-external: generate
	yarn start:external-service:dev

## migrate     — [dev] สร้าง migration ใหม่จาก schema แล้ว apply
migrate:
	yarn prisma:migrate

## deploy      — [prod/CI] apply เฉพาะ migration ที่ commit ไว้ ไม่ถามยืนยัน
deploy:
	yarn prisma:migrate:deploy

## status      — เทียบ migration ที่มีกับ database
status:
	yarn prisma:migrate:status

## reset       — ล้าง database แล้วสร้างใหม่ (ข้อมูลหายทั้งหมด)
reset:
	yarn prisma:migrate:reset

## lint        — eslint ทุก package
lint:
	yarn lint

## test        — jest ทุก workspace
test:
	yarn test

## clean       — ลบ build output ทั้งหมด
clean:
	rm -rf libs/share/dist services/user-service/dist services/core-service/dist \
	       services/external-service/dist

## help        — แสดงรายการคำสั่ง
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## //'
