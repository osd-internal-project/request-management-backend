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
echo "ผ่าน $pass · ตก $fail"
[ "$fail" -eq 0 ]
