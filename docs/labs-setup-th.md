# labs deploy — ต้องทำอะไรบ้าง นอกจาก push

เช็คลิสต์ของคนที่กำลังจะ deploy ขึ้น labs VM
เรื่องการติดตั้งเครื่องครั้งแรก (runner, Docker, ไฟล์ env, Keycloak) อยู่ที่
[`labs-server-setup.md`](./labs-server-setup.md) — ไฟล์นี้ไม่เขียนซ้ำ

> ไฟล์นี้เคยอยู่นอก repo ในชื่อ `LABS-SETUP.md` และอธิบายดีไซน์ที่ส่ง env
> ทั้งหมดมาจาก GitHub Secrets ในชื่อ `LABS_*` — **ดีไซน์นั้นไม่เคยถูก implement**
> ไม่มี workflow ไหนอ่านชื่อ `LABS_*` เลยสักตัว และเวอร์ชันเดิมยังสั่งให้ลบไฟล์ env
> บน VM ทิ้ง ซึ่งทำตามแล้ว deploy พังทันที ส่วนที่ผิดถูกตัดออกหมดแล้ว

---

## 0. env มาจากไหน — อ่านก่อน

ค่า config ของแอปทั้งหมดมาจาก **ไฟล์สองไฟล์ที่อยู่บน VM เท่านั้น**

| ไฟล์ | ใครใช้ |
|---|---|
| `/etc/request-management/.backend.env` | `rm-user`, `rm-core` |
| `/etc/request-management/.frontend.env` | `rm-fe` |

compose อ่านผ่าน `env_file:` ใน `infra/labs/docker-compose.yml` ของแต่ละ repo

ฝั่ง GitHub มีแค่สามอย่างและไม่เกี่ยวกับ config ของแอป —
`HUAWEI_REGISTRY_USERNAME`, `HUAWEI_REGISTRY_PASSWORD` (secrets)
และ `HUAWEI_SWR_ORG` (variable) ทั้งหมดใช้สำหรับ pull image จาก SWR เท่านั้น

**ห้ามลบไฟล์ env บน VM** ไม่มีอะไรสร้างมันขึ้นมาใหม่ให้

---

## 1. Keycloak — ลงทะเบียน redirect URI

client `request-form` ต้องมี URI พวกนี้ ต้องตรงกับ `APP_ORIGIN` ใน `.frontend.env`
ทุกตัวอักษร รวม `http://`, ip และ `:3500`

| ช่อง | ค่า |
|---|---|
| Valid redirect URIs | `http://<ip ของ labs VM>:3500/*` |
| Valid post logout redirect URIs | `http://<ip ของ labs VM>:3500/*` |

**ข้อนี้ผิดแล้ว deploy จะยังขึ้นเขียว** แต่ login ตายด้วย `Invalid parameter: redirect_uri`

ค่าเดียวกันนี้ยังต้องตรงกับ `KEYCLOAK_REDIRECT_URI` และ
`KEYCLOAK_POST_LOGOUT_REDIRECT_URI` ใน `.backend.env` ด้วย — สามที่ ต้องตรงกันหมด

---

## 2. เช็คบน VM ก่อน push

```bash
command -v flock
```

ต้องมี path ออกมา ถ้าไม่มี deploy จะพังทั้งสองรีโปทันที (ติดตั้งด้วย `sudo apt install util-linux`)

จากนั้นเช็คว่า **runner อ่านไฟล์ env ได้จริง** — รันจากไดเรกทอรีงานของ runner

```bash
sudo -u github-runner bash scripts/check-labs-env.sh /etc/request-management/.backend.env
sudo -u github-runner bash scripts/check-labs-env.sh /etc/request-management/.frontend.env
```

`sudo -u github-runner` เป็นส่วนสำคัญ ห้ามตัดทิ้ง — รันเป็น root มันอ่านผ่านทุกกรณี
เพราะ root ข้าม mode bits จับเคสไฟล์ mode 600 ที่ทำให้ deploy พังไม่ได้เลย

ตั้งแต่ตอนนี้ deploy เรียกสคริปต์ตัวนี้ให้เองเป็น step แรกหลัง checkout
จึงพังตั้งแต่ต้นพร้อมบอกสาเหตุ แทนที่จะไปตายตอน `docker compose up`

---

## 3. push

push ทั้งสองรีโปขึ้น branch `deploys/labs`

---

## 4. หลัง deploy ผ่าน

```bash
# ทั้งสามต้องได้ healthy
docker inspect --format '{{.State.Health.Status}}' rm-user rm-core rm-fe
```

เปิดเบราว์เซอร์ไปที่ `APP_ORIGIN` แล้ว **login ให้เข้าหน้าแรกได้จริง** —
ข้อนี้เท่านั้นที่พิสูจน์ว่า redirect URI ถูก deploy สีเขียวพิสูจน์ไม่ได้

---

## ถ้าพัง

| ข้อความ | แปลว่า |
|---|---|
| `... does not exist — this VM has not been provisioned` | ยังไม่ได้สร้าง `/etc/request-management` — ดู `labs-server-setup.md` §4 |
| `... does not exist` (ไฟล์) | ไฟล์ env หายจริง สร้างใหม่ตาม `labs-server-setup.md` §4 |
| `... exists but github-runner cannot read it` | ไฟล์อยู่ครบแต่สิทธิ์ผิด — `sudo chgrp github-runner <ไฟล์> && sudo chmod 640 <ไฟล์>` |
| `... is readable but holds no KEY=value line` | ไฟล์ว่าง คัดค่าจาก `.env.labs.example` มาใส่ |
| `env file ... not found` จาก compose | guard ถูกข้ามไป — เช็คว่า step `Check Labs Env File` รันหรือยัง |
| `Invalid parameter: redirect_uri` ตอน login | ข้อ 1 ไม่ตรงกับ `APP_ORIGIN` |
| `flock: command not found` | ข้อ 2 |
| container ขึ้นแล้ว healthcheck ตายใน ~3 นาที | ไฟล์ env อ่านได้แต่ค่าไม่ครบ — guard ไม่จับเคสนี้ ดู `docker compose logs` |
