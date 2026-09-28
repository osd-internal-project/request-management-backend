#!/usr/bin/env bash
#
# รัน backend ทุก service โหมด watch พร้อมกันในหน้าต่างเดียว — Ctrl+C หยุดทุกตัว
#
#   bash scripts/dev-all.sh                 # ทั้งสี่ตัว
#   bash scripts/dev-all.sh core user       # เลือกเฉพาะบางตัว
#   SKIP_GENERATE=1 bash scripts/dev-all.sh # ข้าม prisma generate
#
# log ของแต่ละ service มี prefix สีกำกับ เช่น [core] …
set -uo pipefail

cd "$(dirname "$0")/.."

# Homebrew node 22.9.0 (x64) ทำ install/jest พัง — ใช้ nvm 22.13.0 ถ้ามี
NVM_NODE_BIN="${NVM_NODE_BIN:-$HOME/.nvm/versions/node/v22.13.0/bin}"
if [ -d "$NVM_NODE_BIN" ]; then
  export PATH="$NVM_NODE_BIN:$PATH"
fi

# ชื่อสั้น:workspace:port:สี
ALL_SERVICES=(
  "user:user-service:3001:36"
  "core:core-service:3002:32"
  "external:external-service:3003:35"
  "runnumber:run-number-service:3004:33"
)

usage() {
  echo "usage: $0 [user] [core] [external] [runnumber]" >&2
  exit 1
}

selected=()
if [ $# -eq 0 ]; then
  selected=("${ALL_SERVICES[@]}")
else
  for want in "$@"; do
    match=""
    for entry in "${ALL_SERVICES[@]}"; do
      [ "${entry%%:*}" = "$want" ] && match="$entry"
    done
    [ -n "$match" ] || { echo "ไม่รู้จัก service: $want" >&2; usage; }
    selected+=("$match")
  done
fi

port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

for entry in "${selected[@]}"; do
  IFS=: read -r name _ port _ <<<"$entry"
  if port_in_use "$port"; then
    echo "port $port ($name) ถูกใช้อยู่แล้ว — ปิดตัวเดิมก่อน: lsof -nP -iTCP:$port -sTCP:LISTEN" >&2
    exit 1
  fi
done

echo "node $(node -v) — $(command -v node)"

if [ -z "${SKIP_GENERATE:-}" ]; then
  yarn prisma:generate || { echo "prisma generate ล้มเหลว" >&2; exit 1; }
fi

# kill 0 ส่งสัญญาณถึงทั้ง process group จึงเก็บ nest --watch ที่เป็นลูกหลานได้หมด
trap 'trap - INT TERM EXIT; echo; echo "stopping all services…"; kill 0 2>/dev/null; wait' INT TERM EXIT

for entry in "${selected[@]}"; do
  IFS=: read -r name workspace port color <<<"$entry"
  prefix=$(printf '\033[%sm[%s]\033[0m ' "$color" "$name")
  echo "starting $workspace on :$port"
  yarn --silent workspace "@request-management/$workspace" start:dev 2>&1 \
    | awk -v p="$prefix" '{ print p $0; fflush() }' &
done

wait
