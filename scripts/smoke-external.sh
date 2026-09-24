#!/usr/bin/env bash
#
# ยิง External API ด้วยกุญแจจริงแล้วตรวจ HTTP status — ทั้งเคสที่ต้องผ่านและเคสที่
# ต้องถูกปฏิเสธ เพราะครึ่งหลังคือส่วนที่พิสูจน์ว่าประตูยังปิดอยู่ ไม่ใช่แค่เปิดได้
#
#   API_KEY=rfk_… ACTING_USER=someone@osd.co.th bash scripts/smoke-external.sh
#   BASE_URL=http://192.168.31.52:3503/api/v1 API_KEY=… bash scripts/smoke-external.sh
#
# ไม่ต้องติดตั้งอะไรเพิ่ม — collection ของ Postman อ่านสเปกเดียวกันนี้ ถ้าอยากยิงทั้ง
# 86 request ให้ import จาก docs/postman/ แล้วตั้ง access_token เป็นค่า API_KEY
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3003/api/v1}"
API_KEY="${API_KEY:?ต้องตั้ง API_KEY=rfk_…}"
ACTING_USER="${ACTING_USER:?ต้องตั้ง ACTING_USER=<อีเมลที่เคย login แล้ว>}"

pass=0
fail=0

# check <ชื่อ> <status ที่คาด> <curl args…>
check() {
  local label="$1" want="$2"; shift 2
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$@")

  if [ "$got" = "$want" ]; then
    printf '  [ผ่าน] %s — %s\n' "$label" "$got"
    pass=$((pass + 1))
  else
    printf '  [ตก]  %s — ได้ %s คาด %s\n' "$label" "$got" "$want"
    fail=$((fail + 1))
  fi
}

auth=(-H "Authorization: Bearer $API_KEY")
acting=(-H "X-Acting-User: $ACTING_USER")

echo "ยิงที่ $BASE_URL"
echo
echo "ต้องผ่าน — สองประตูครบ"
check 'GET /crm/customers'        200 "${auth[@]}" "${acting[@]}" "$BASE_URL/crm/customers"
check 'GET /request/request-types' 200 "${auth[@]}" "${acting[@]}" "$BASE_URL/request/request-types"
check 'GET /crm/leads/statuses'   200 "${auth[@]}" "${acting[@]}" "$BASE_URL/crm/leads/statuses"
# ประตูเดียว ห้ามส่ง X-Acting-User — เคยเรียกไม่ถึงเพราะชน path กับ sales create
check 'POST /crm/leads/intake'    201 -X POST "${auth[@]}" -H 'content-type: application/json' \
  -d '{"name":"smoke intake"}' "$BASE_URL/crm/leads/intake"

echo
echo "ต้องถูกปฏิเสธ — และนั่นคือความถูกต้อง"
# ไม่มี Authorization เลย
check 'ไม่มี credential'          401 "${acting[@]}" "$BASE_URL/crm/customers"
# กุญแจปลอม
check 'กุญแจที่ไม่มีในระบบ'        401 -H 'Authorization: Bearer rfk_ไม่มีจริง' "${acting[@]}" "$BASE_URL/crm/customers"
# route ที่มีประตูของคน แต่ไม่ส่ง X-Acting-User
# VALIDATION_FAILED = 400 ตาม ErrorCatalog ไม่ใช่ 422 (นั่นคือ UNPROCESSABLE)
check 'ขาด X-Acting-User'         400 "${auth[@]}" "$BASE_URL/crm/customers"
# อีเมลที่ยังไม่เคย login
check 'X-Acting-User ที่ไม่มีตัวตน' 404 "${auth[@]}" -H 'X-Acting-User: ไม่มีคนนี้@example.com' "$BASE_URL/crm/customers"

echo
echo "MCP — endpoint เดียว ทุก tool อยู่ใน body"

# JSON-RPC ตอบ 200 แม้ตอนที่มันปฏิเสธ status code จึงบอกอะไรไม่ได้ ต้องอ่าน body
# `expr` เป็นนิพจน์ python บนตัวแปร `r` ที่ต้องเป็นจริง
rpc() {
  local label="$1" expr="$2" body="$3"; shift 3
  local out
  out=$(curl -s -m 20 -X POST -H 'content-type: application/json' "$@" -d "$body" "$BASE_URL/mcp")

  if printf '%s' "$out" | python3 -c \
    "import sys,json;r=json.load(sys.stdin);sys.exit(0 if ($expr) else 1)" 2>/dev/null; then
    printf '  [ผ่าน] %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '  [ตก]  %s — %.200s\n' "$label" "$out"
    fail=$((fail + 1))
  fi
}

rpc 'initialize ตอบรุ่นที่พูดได้จริง' \
  "r['result']['protocolVersion'] == '2024-11-05'" \
  '{"jsonrpc":"2.0","id":1,"method":"initialize"}' "${auth[@]}"

# เคสที่จับกรณี catalogue ไม่ติดไปกับ image: MCP ปิดตัวเองเงียบ ๆ โดย service อื่นยังเขียว
rpc 'tools/list มี tool มากกว่าศูนย์' \
  "len(r['result']['tools']) > 0" \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' "${auth[@]}"

rpc 'tools/call ทำงานสำเร็จ' \
  "not r['result'].get('isError')" \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"request_get_request_types","arguments":{}}}' \
  "${auth[@]}" "${acting[@]}"

rpc 'ชื่อ tool ที่ไม่มี → -32602' \
  "r['error']['code'] == -32602" \
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"ไม่มี tool นี้","arguments":{}}}' \
  "${auth[@]}" "${acting[@]}"

# ตัวตนถูก resolve ต่อการเรียก tool ไม่ใช่ต่อ HTTP request — initialize/tools/list จึงผ่านได้
# โดยไม่มี header นี้ แต่ tools/call ต้องมี
rpc 'ขาด X-Acting-User ตอน tools/call' \
  "r['result']['isError'] and 'VALIDATION_FAILED' in r['result']['content'][0]['text']" \
  '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"request_get_request_types","arguments":{}}}' \
  "${auth[@]}"

check 'MCP ไม่มี credential' 401 -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":6,"method":"tools/list"}' "$BASE_URL/mcp"

# RFC 9728 — ตัวชี้ทางที่ทำให้ปุ่ม "เชื่อมต่อ" ของ chat client โผล่ขึ้นมา ขาดไปแล้ว
# ไคลเอนต์เจอ 401 เปล่า ๆ โดยไม่รู้ว่าต้องไป login ที่ไหน
if curl -s -m 20 -D - -o /dev/null -X POST -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":7,"method":"tools/list"}' "$BASE_URL/mcp" \
    | grep -qi '^www-authenticate:.*resource_metadata'; then
  printf '  [ผ่าน] 401 ชี้ทางไป resource_metadata\n'
  pass=$((pass + 1))
else
  printf '  [ตก]  401 ไม่มี header WWW-Authenticate\n'
  fail=$((fail + 1))
fi

echo
echo "ผ่าน $pass · ตก $fail"
[ "$fail" -eq 0 ]
