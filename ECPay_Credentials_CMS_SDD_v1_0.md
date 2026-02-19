# ECPay 金流憑證 CMS 管理 — 系統設計文件 (SDD)

| 項目 | 內容 |
|------|------|
| 版本 | v1.0 |
| 日期 | 2026-02-18 |
| 狀態 | 待開發 |
| 安全等級 | 🔴 高（涉及金流憑證） |

---

## 1. 設計目標

讓商家可以透過 CMS 後台自行管理 ECPay 金流/物流憑證，包含：

- 查看目前使用的 MerchantID（遮罩顯示 HashKey/HashIV）
- 更新 staging / production 憑證
- 一鍵切換 staging ↔ production 環境
- 所有操作留下完整 audit trail

### 1.1 安全核心原則

```
ENCRYPTION_KEY 只存在 Gateway（Railway）
       ↑ 唯一加解密責任點
       │
CMS 永遠不接觸 ENCRYPTION_KEY
CMS 永遠不接觸加密後的值
CMS 只透過 Gateway Admin API 操作
```

---

## 2. 系統架構

### 2.1 資料流（選項 A：Gateway Admin API 代理模式）

```
CMS 商家設定頁（管理員操作）
  │
  │ ① 明文 credentials（瀏覽器 → CMS server，HTTPS 加密傳輸）
  ▼
CMS API Route（Next.js server-side）
  │
  │ ② POST /admin/merchants/:code/credentials
  │    Headers: x-admin-api-key: {GATEWAY_ADMIN_API_KEY}
  │    Body: { merchant_id, hash_key, hash_iv, environment }
  │    （HTTPS 加密傳輸）
  ▼
ECPay Gateway Admin API（Railway）
  │
  │ ③ 驗證 admin API key
  │ ④ AES-256-CBC 加密 hash_key / hash_iv（使用 ENCRYPTION_KEY）
  │ ⑤ UPDATE gateway_merchants SET ecpay_hash_key_encrypted=..., ecpay_hash_iv_encrypted=...
  │ ⑥ INSERT audit_log（operator, action, target, ip, timestamp）
  │ ⑦ 回傳 { success: true }（不回傳加密值）
  ▼
Supabase（加密態儲存，RLS: service_role only）
```

### 2.2 讀取流程

```
CMS 商家設定頁 → 載入時顯示憑證狀態
  │
  │ GET /admin/merchants/:code/credentials
  ▼
Gateway Admin API
  │
  │ 查詢 gateway_merchants WHERE code = :code
  │ 回傳遮罩後的資訊（不解密）：
  │ {
  │   merchant_id: "3386672",
  │   hash_key_masked: "DMoH****uPva",     ← 前4後4，中間*
  │   hash_iv_masked: "vjiI****x31H",
  │   environment: "production",
  │   is_staging: false,
  │   last_updated: "2026-02-18T00:25:02Z"
  │ }
  ▼
CMS 前端顯示
```

### 2.3 交易時讀取（不變）

```
客戶結帳 → Storefront → Gateway /api/v1/payment/checkout
  │
  │ Gateway 用 merchant API key 找到 gateway_merchants
  │ AES-256 解密 hash_key / hash_iv
  │ 用解密後的值計算 CheckMacValue
  │ 送出 ECPay 請求
  ▼
ECPay
```

---

## 3. Gateway 新增 Admin API

### 3.1 端點設計

| 方法 | 端點 | 說明 | 認證 |
|------|------|------|------|
| GET | `/api/v1/admin/merchants/:code/credentials` | 查詢憑證狀態（遮罩） | ADMIN_API_KEY |
| PUT | `/api/v1/admin/merchants/:code/credentials` | 更新憑證 | ADMIN_API_KEY |
| POST | `/api/v1/admin/merchants/:code/switch-env` | 切換環境 | ADMIN_API_KEY |
| POST | `/api/v1/admin/merchants/:code/test-credentials` | 測試憑證有效性 | ADMIN_API_KEY |

### 3.2 GET /credentials — 查詢（遮罩顯示）

**Request:**
```
GET /api/v1/admin/merchants/minjie/credentials
Headers:
  x-admin-api-key: {ADMIN_API_KEY}
```

**Response:**
```json
{
  "success": true,
  "credentials": {
    "code": "minjie",
    "ecpay_merchant_id": "3386672",
    "hash_key_set": true,
    "hash_key_masked": "DMoH****uPva",
    "hash_iv_set": true,
    "hash_iv_masked": "vjiI****x31H",
    "is_staging": false,
    "environment": "production",
    "updated_at": "2026-02-18T00:25:02Z"
  }
}
```

**遮罩規則：**
- 長度 ≤ 4：全部用 `*`
- 長度 5-8：前2後2，中間 `*`
- 長度 > 8：前4後4，中間 `****`

**實作重點：**
- 解密 hash_key/hash_iv → 遮罩 → 回傳
- 不回傳加密值（encrypted 欄位）
- 不回傳完整明文

### 3.3 PUT /credentials — 更新憑證

**Request:**
```
PUT /api/v1/admin/merchants/minjie/credentials
Headers:
  x-admin-api-key: {ADMIN_API_KEY}
  Content-Type: application/json
Body:
{
  "ecpay_merchant_id": "3386672",
  "ecpay_hash_key": "DMoHMf9gPuSNuPva",
  "ecpay_hash_iv": "vjiIBrJ5bx31HItE",
  "environment": "production"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Credentials updated successfully",
  "credentials": {
    "ecpay_merchant_id": "3386672",
    "hash_key_masked": "DMoH****uPva",
    "hash_iv_masked": "vjiI****x31H",
    "environment": "production"
  }
}
```

**處理邏輯：**
```
1. 驗證 ADMIN_API_KEY
2. 驗證 merchant code 存在
3. 輸入驗證：
   - ecpay_merchant_id: 必填，7-10 位數字
   - ecpay_hash_key: 必填，16 字元
   - ecpay_hash_iv: 必填，16 字元
   - environment: "staging" | "production"
4. AES-256-CBC 加密 hash_key 和 hash_iv
5. UPDATE gateway_merchants:
   - ecpay_merchant_id = 新值
   - ecpay_hash_key_encrypted = 加密後
   - ecpay_hash_iv_encrypted = 加密後
   - is_staging = (environment === 'staging')
   - updated_at = NOW()
6. 寫入 audit log:
   - action: 'update_payment_credentials'
   - target: merchant code
   - details: { merchant_id, environment, ip }（不記錄 key/iv）
7. 回傳遮罩後的確認
```

### 3.4 POST /switch-env — 環境切換

**Request:**
```
POST /api/v1/admin/merchants/minjie/switch-env
Headers:
  x-admin-api-key: {ADMIN_API_KEY}
Body:
{
  "target_environment": "production",
  "confirm": true
}
```

**處理邏輯：**
```
1. 驗證 ADMIN_API_KEY
2. 查詢 merchant 當前狀態
3. 如果 confirm !== true → 回傳 400 "Confirmation required"
4. UPDATE gateway_merchants SET is_staging = (target === 'staging')
5. 寫入 audit log: action = 'switch_payment_environment'
6. 回傳 { success, previous_environment, current_environment }
```

### 3.5 POST /test-credentials — 驗證憑證

**目的：** 在切換前驗證憑證是否有效（呼叫 ECPay QueryTradeInfo API）

**Request:**
```
POST /api/v1/admin/merchants/minjie/test-credentials
Headers:
  x-admin-api-key: {ADMIN_API_KEY}
Body:
{
  "environment": "production"
}
```

**處理邏輯：**
```
1. 解密目前儲存的 hash_key / hash_iv
2. 用這組憑證呼叫 ECPay QueryTradeInfo API（查一筆不存在的交易）
3. 如果 ECPay 回傳「查無此筆交易」→ 憑證有效（能連上 ECPay）
4. 如果 ECPay 回傳「CheckMacValue 驗證錯誤」→ 憑證無效
5. 回傳 { valid: true/false, message: "..." }
```

**ECPay 端點：**
- Staging: `https://payment-stage.ecpay.com.tw/Cashier/QueryTradeInfo/V5`
- Production: `https://payment.ecpay.com.tw/Cashier/QueryTradeInfo/V5`

---

## 4. Gateway 實作細節

### 4.1 新增路由檔案

```
src/routes/admin.js  ← 新增
```

### 4.2 Admin 認證 Middleware

```javascript
// src/middleware/adminAuth.js
function adminAuth(req, res, next) {
  const apiKey = req.headers['x-admin-api-key'];
  if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // 記錄來源 IP
  req.adminIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  next();
}
```

### 4.3 遮罩函數

```javascript
function maskSecret(value) {
  if (!value) return '(not set)';
  const len = value.length;
  if (len <= 4) return '*'.repeat(len);
  if (len <= 8) return value.slice(0, 2) + '****' + value.slice(-2);
  return value.slice(0, 4) + '****' + value.slice(-4);
}
```

### 4.4 Audit Log

使用現有 `audit_log` 表（CMS schema），透過 Supabase service_role 寫入：

```javascript
async function logCredentialChange(action, merchantCode, details, ip) {
  await supabase.from('audit_log').insert({
    operator_id: 'system',
    operator_name: 'Gateway Admin API',
    action,
    module: 'payment_credentials',
    target_type: 'gateway_merchants',
    target_id: merchantCode,
    details: JSON.stringify({
      ...details,
      source_ip: ip,
      timestamp: new Date().toISOString()
    })
  });
}
```

---

## 5. CMS 管理介面

### 5.1 在「商家設定」頁面新增區塊

位置：商家設定頁，在「LINE OA 設定」和「功能開關」之間，新增「💳 金流設定」區塊。

### 5.2 UI 設計

```
┌─────────────────────────────────────────────────────┐
│ 💳 金流設定                                          │
│                                                      │
│  ┌─── 目前環境 ──────────────────────────────────┐   │
│  │                                                │   │
│  │  環境：🟢 正式環境 (Production)                 │   │
│  │               ─ 或 ─                           │   │
│  │  環境：🟡 測試環境 (Staging)                    │   │
│  │                                                │   │
│  └────────────────────────────────────────────────┘   │
│                                                      │
│  ┌─── 金流商家 (minjie) ─────────────────────────┐   │
│  │                                                │   │
│  │  商店代號 (MerchantID)                         │   │
│  │  ┌──────────────────────────────────────┐     │   │
│  │  │ 3386672                              │     │   │
│  │  └──────────────────────────────────────┘     │   │
│  │                                                │   │
│  │  HashKey                                       │   │
│  │  ┌──────────────────────────────────────┐     │   │
│  │  │ DMoH****uPva         [👁 顯示]       │     │   │
│  │  └──────────────────────────────────────┘     │   │
│  │                                                │   │
│  │  HashIV                                        │   │
│  │  ┌──────────────────────────────────────┐     │   │
│  │  │ vjiI****x31H         [👁 顯示]       │     │   │
│  │  └──────────────────────────────────────┘     │   │
│  │                                                │   │
│  │  [🔄 更新憑證]  [✅ 測試連線]                   │   │
│  │                                                │   │
│  └────────────────────────────────────────────────┘   │
│                                                      │
│  ┌─── 物流商家 (minjie-c2c) ─────────────────────┐   │
│  │  （同上結構）                                   │   │
│  └────────────────────────────────────────────────┘   │
│                                                      │
│  ────────────────────────────────────────────────     │
│                                                      │
│  ⚠️ 環境切換                                         │
│  目前：🟢 正式環境                                    │
│                                                      │
│  [切換至測試環境]                                      │
│    ↑ 點擊後跳出二次確認 Modal                         │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### 5.3 「更新憑證」Modal

```
┌────────────────────────────────────────────┐
│  更新金流憑證                               │
│                                            │
│  ⚠️ 請確認您的 ECPay 商店憑證正確，         │
│     錯誤的憑證將導致付款功能異常。           │
│                                            │
│  商店代號 (MerchantID)                     │
│  ┌──────────────────────────────────┐     │
│  │ 3386672                          │     │
│  └──────────────────────────────────┘     │
│                                            │
│  HashKey（16 字元）                        │
│  ┌──────────────────────────────────┐     │
│  │ ●●●●●●●●●●●●●●●●                │     │
│  └──────────────────────────────────┘     │
│                                            │
│  HashIV（16 字元）                         │
│  ┌──────────────────────────────────┐     │
│  │ ●●●●●●●●●●●●●●●●                │     │
│  └──────────────────────────────────┘     │
│                                            │
│  ☐ 我確認以上憑證正確無誤                   │
│                                            │
│          [取消]    [儲存憑證]               │
│                                            │
└────────────────────────────────────────────┘
```

### 5.4 「環境切換」確認 Modal

```
┌────────────────────────────────────────────┐
│  ⚠️ 切換金流環境                            │
│                                            │
│  您即將從 🟢 正式環境 切換到 🟡 測試環境      │
│                                            │
│  切換後：                                   │
│  • 所有新交易將使用測試憑證                   │
│  • 正在進行的交易不受影響                    │
│  • 客戶付款將進入 ECPay 測試環境             │
│                                            │
│  請輸入「確認切換」以繼續：                   │
│  ┌──────────────────────────────────┐     │
│  │                                  │     │
│  └──────────────────────────────────┘     │
│                                            │
│          [取消]    [確認切換]               │
│                                            │
└────────────────────────────────────────────┘
```

### 5.5 CMS API Route

```
app/api/payment-credentials/route.ts     ← GET / PUT
app/api/payment-credentials/switch/route.ts  ← POST (環境切換)
app/api/payment-credentials/test/route.ts    ← POST (測試連線)
```

所有 route 都是 server-side，透過 GATEWAY_ADMIN_API_KEY 呼叫 Gateway：

```typescript
// app/api/payment-credentials/route.ts
// GET: 讀取遮罩憑證
// PUT: 更新憑證（proxy 到 Gateway）

const GATEWAY_URL = process.env.ECPAY_GATEWAY_URL;
const GATEWAY_ADMIN_KEY = process.env.GATEWAY_ADMIN_API_KEY;

export async function GET(request: NextRequest) {
  // 1. 驗證 CMS session（已登入的管理員）
  // 2. 從 searchParams 取 merchant_code
  // 3. fetch Gateway GET /admin/merchants/:code/credentials
  // 4. 回傳遮罩資料
}

export async function PUT(request: NextRequest) {
  // 1. 驗證 CMS session
  // 2. 從 body 取得明文憑證
  // 3. fetch Gateway PUT /admin/merchants/:code/credentials
  // 4. 寫入 CMS audit_log（CMS 端也記一筆）
  // 5. 回傳結果
}
```

---

## 6. CMS 環境變數

CMS Admin（Vercel）需要新增 1 個環境變數：

| 變數名 | 說明 | 來源 |
|--------|------|------|
| `GATEWAY_ADMIN_API_KEY` | Gateway Admin API 認證金鑰 | Railway env `ADMIN_API_KEY` 的值 |

**注意：** 這個 key 已經存在於 Gateway，CMS 只是需要知道這個值才能呼叫 admin API。不需要新建 key。

---

## 7. 安全措施清單

### 7.1 傳輸安全

| # | 措施 | 說明 |
|---|------|------|
| 1 | HTTPS only | CMS→Gateway 全程 HTTPS |
| 2 | Gateway CORS | Admin API 只允許 CMS domain |
| 3 | Admin API Key | 每個請求必須帶 x-admin-api-key |

### 7.2 儲存安全

| # | 措施 | 說明 |
|---|------|------|
| 4 | AES-256-CBC 加密 | hash_key/hash_iv 加密後存 DB |
| 5 | ENCRYPTION_KEY 隔離 | 只存在 Gateway（Railway env），不擴散 |
| 6 | RLS service_role only | gateway_merchants 表前端完全不可存取 |

### 7.3 操作安全

| # | 措施 | 說明 |
|---|------|------|
| 7 | 二次確認 | 更新憑證需勾選「確認正確」；環境切換需輸入「確認切換」 |
| 8 | 遮罩顯示 | CMS 不顯示完整 key/iv，只顯示遮罩 |
| 9 | 雙重 Audit | Gateway 寫一筆 + CMS 寫一筆 |
| 10 | 不記錄明文 | Audit log 不記錄 hash_key / hash_iv 值 |
| 11 | 測試先行 | 提供測試連線功能，切換前驗證憑證有效性 |

### 7.4 攻擊防護

| 攻擊向量 | 防護 |
|----------|------|
| CMS Vercel 被入侵 | 攻擊者只能拿到 GATEWAY_ADMIN_API_KEY，無法取得 ENCRYPTION_KEY → 無法解密已儲存的憑證 |
| 攔截 CMS→Gateway 請求 | HTTPS 加密，且 Admin API Key 驗證 |
| 前端 JS 注入 | 所有 API 呼叫走 server-side route，前端不直接呼叫 Gateway |
| DB 直接存取 | RLS 限制 service_role，加密儲存 |

---

## 8. 現有 gateway_merchants 資料

需要支援的三個 merchant：

| Code | 用途 | 目前 MerchantID | 目前環境 |
|------|------|----------------|---------|
| `minjie` | 金流（信用卡/ATM） | 3002607 (staging) → 3386672 (production) | staging |
| `minjie-logistics` | B2C 物流 | 2000132 | staging |
| `minjie-c2c` | C2C 物流（交貨便） | 2000933 | staging |

**CMS UI 顯示邏輯：**
- 依 merchant code 分組顯示
- `minjie` 顯示為「金流」
- `minjie-logistics` 顯示為「B2C 物流」
- `minjie-c2c` 顯示為「C2C 物流」
- 環境切換同時切換三個 merchant（金流 + 物流需保持一致）

---

## 9. 實作步驟

### Phase 1：Gateway Admin API（約 3 小時）

```
1. 建立 src/routes/admin.js
2. 實作 adminAuth middleware
3. 實作 GET /admin/merchants/:code/credentials（遮罩查詢）
4. 實作 PUT /admin/merchants/:code/credentials（更新 + 加密）
5. 實作 POST /admin/merchants/:code/switch-env（環境切換）
6. 實作 POST /admin/merchants/:code/test-credentials（測試連線）
7. 在 src/index.js 掛載 /api/v1/admin 路由
8. 加入 CORS 允許 CMS domain
9. 測試：curl 呼叫 4 個端點確認
10. 部署 Railway
```

### Phase 2：CMS API Routes + UI（約 3 小時）

```
1. 建立 app/api/payment-credentials/route.ts（GET + PUT proxy）
2. 建立 app/api/payment-credentials/switch/route.ts（POST proxy）
3. 建立 app/api/payment-credentials/test/route.ts（POST proxy）
4. 在商家設定頁新增「金流設定」區塊
5. 實作遮罩顯示、更新 Modal、環境切換 Modal
6. 加入 GATEWAY_ADMIN_API_KEY 環境變數到 Vercel
7. 測試：CMS 操作 → Gateway 日誌確認
8. 部署 vercel --prod
```

### Phase 3：ECPay Production 切換（約 30 分鐘）

```
1. 在 CMS 金流設定頁填入 production 憑證
2. 點「測試連線」確認有效
3. 點「切換至正式環境」，輸入確認文字
4. 用真實信用卡下一筆 $420+ 測試單
5. 確認 ECPay 後台收到交易
6. 完成！🎉
```

---

## 10. 與現有系統的整合點

| 系統 | 整合方式 | 變更程度 |
|------|----------|---------|
| Gateway (`src/routes/`) | 新增 `admin.js` 路由檔 | 新增，不動現有程式碼 |
| Gateway (`src/index.js`) | 掛載 `/api/v1/admin` | 1 行 |
| Gateway (`src/middleware/`) | 新增 `adminAuth.js` | 新增 |
| CMS (`app/s/[token]/settings/`) | 商家設定頁加區塊 | 修改 |
| CMS (`app/api/`) | 新增 3 個 proxy route | 新增 |
| Supabase | 不需要 schema 變更 | 不動 |
| Storefront | 不需要變更 | 不動 |
| Medusa | 不需要變更 | 不動 |

---

## 11. 版本歷史

| 日期 | 版本 | 變更說明 |
|------|------|----------|
| 2026-02-18 | v1.0 | 初版：Gateway Admin API 代理模式，CMS 金流設定 UI |

---

*此文件為 ECPay 金流憑證 CMS 管理功能的完整設計規格。ENCRYPTION_KEY 隔離原則為最高安全約束，所有實作必須遵守。*
