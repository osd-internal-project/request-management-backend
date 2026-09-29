# CD-51 แจ้งเตือนผ่าน Microsoft Teams

ผู้ใช้ตัดสินใจ 29 ก.ย. 2569: แจ้งเข้า **แชทส่วนตัวของผู้รับกับบอท** (ไม่ใช่ channel ของทีม) —
เรื่องเดียวกับที่แจ้งในระบบ/อีเมล ช่องทางเดียวกัน กติกาเดียวกัน (CD-52/53/54)

## ทำงานอย่างไร

1. ทุกการแจ้งเตือน (`NotificationsService.emit`) — ถ้าเปิดช่องทาง Teams และผู้รับไม่ได้ปิด
   → เขียนแถว `notification_delivery_logs` ช่องทาง `teams` สถานะ `queued` **ไม่ส่งในจังหวะนั้น**
   (งานที่ทำให้เกิดการแจ้งเตือนไม่ต้องรอ Microsoft)
2. `TeamsDeliveryService` (core-service ทุก 15 วินาที) ส่งแถวที่ถึงเวลา:
   token ของแอป → หาผู้ใช้ใน Microsoft 365 จากอีเมล (ครั้งแรก) → เปิดแชท 1:1 กับบอท (ครั้งแรก
   เก็บไว้ใน `teams_chat_links`) → ส่ง Adaptive Card (หัวข้อ · เนื้อหา · ปุ่มเปิดในระบบ)
3. ผลบันทึกในแถวเดิม — ดูได้ที่หน้า **บันทึกการแจ้งเตือน** (CD-55) เหมือนอีเมล
   - ผิดพลาดชั่วคราว (throttle/timeout) → ลองใหม่ 1 · 5 · 15 · 60 นาที รวม 5 ครั้ง แล้ว `failed`
   - ผิดถาวร (ไม่พบผู้ใช้ใน Microsoft 365 / ยังไม่ได้ติดตั้งแอปบอทให้คนนั้น / ไม่มีอีเมล) → `failed` ทันที พร้อมเหตุผล
4. รายการที่รวมเป็นสรุปรายวัน (CD-52) ไม่ส่งทีละรายการ — สรุปไปทั้งอีเมลและ Teams

ผู้ใช้ปิด/เปิด Teams ของตัวเองได้ที่หน้าการแจ้งเตือน (สวิตช์โผล่เมื่อระบบเปิดช่องทาง Teams เท่านั้น)

## โหมด (`TEAMS_MODE`)

| โหมด | |
|---|---|
| `off` (ค่าตั้งต้น) | ไม่มีช่องทาง Teams — ไม่เข้าคิว ไม่มีสวิตช์บนหน้าจอ |
| `mock` | เข้าคิวและ "ส่ง" โดยแค่ log — ไว้ทดสอบ (บันทึกเป็น sent) |
| `botframework` | ส่งจริง — ต้องตั้งค่าครบ ไม่อย่างนั้น core-service ไม่ยอม start |

external-service เรียก `emit` ได้ด้วย (เช่นผ่าน API ภายนอก) จึงต้องตั้ง `TEAMS_MODE` ให้ตรงกัน
แต่ตัวส่งทำงานเฉพาะ core-service

## สิ่งที่ทีม IT ต้องทำ (ก่อนเปลี่ยนเป็น botframework)

1. **Azure Bot** (single-tenant) + App registration → ได้ `TEAMS_BOT_APP_ID`, client secret
   (`TEAMS_BOT_APP_PASSWORD`), `TEAMS_TENANT_ID` · เปิด channel **Microsoft Teams** ใน Azure Bot
2. สิทธิ์ Microsoft Graph แบบ **Application**: `User.Read.All` (หาผู้ใช้จากอีเมล) + admin consent
3. ทำ **แอป Teams** จาก bot นี้ (manifest มี `bots[].botId` = app id, scope `personal`) แล้ว
   **ติดตั้งให้ผู้ใช้ทั้งองค์กร** ผ่าน Teams admin center (setup policy) — บอทเปิดแชทหาใครได้
   เฉพาะคนที่มีแอปแล้ว
4. `TEAMS_SERVICE_URL` = Bot Connector ตามภูมิภาค (เอเชีย: `https://smba.trafficmanager.net/apac/`)
5. `PUBLIC_WEB_URL` = URL ของหน้าเว็บ (ปุ่มบนการ์ดพาไปหน้าการแจ้งเตือน)
6. ขาออกจาก core-service ต้องถึง `login.microsoftonline.com`, `graph.microsoft.com`, `smba.trafficmanager.net`

อีเมลในระบบ (`users.email`) ต้องตรงกับ mail หรือ UPN ใน Microsoft 365
