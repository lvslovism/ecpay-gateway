# ECPay 金流憑證 CMS 管理 — Claude Code 實作指令

> 分兩個 repo 執行：先 Gateway，後 CMS

---

## Phase 1：Gateway Admin API（在 ecpay-gateway repo 執行）

### Step 1：建立 Admin Auth Middleware

在 `src/middleware/` 建立 `adminAuth.js`：

```
建立 admin 認證中間件。

檔案：src/middleware/adminAuth.js

邏輯：
1. 讀取 header x-admin-api-key
2. 比對 process.env.ADMIN_API_KEY
3. 不符 → 401 { error: 'Unauthorized' }
4. 符合 → req.adminIp = x-forwarded-for 或 connection.remoteAddress → next()

ADMIN_API_KEY 環境變數已存在（建立商家 POST /api/v1/merchants 已在用）。
```

### Step 2：建立 Admin 路由

在 `src/routes/` 建立 `admin.js`，掛載到 `/api/v1/admin`：

```
建立 Gateway Admin API 路由，管理 ECPay 金流憑證。

檔案：src/routes/admin.js

所有端點都用 adminAuth middleware 保護。
加密解密用現有的 encrypt() / decrypt() 函數（在 src/services/ 或 src/routes/ 中找到現有的加密邏輯，import 過來）。

實作以下 4 個端點：

### GET /merchants/:code/credentials
1. 查 gateway_merchants WHERE code = :code
2. 找不到 → 404
3. 解密 ecpay_hash_key_encrypted 和 ecpay_hash_iv_encrypted
4. 用遮罩函數處理（前4後4，中間 ****）
5. 回傳：
{
  success: true,
  credentials: {
    code, ecpay_merchant_id,
    hash_key_set: true/false,
    hash_key_masked: "DMoH****uPva",
    hash_iv_set: true/false,
    hash_iv_masked: "vjiI****x31H",
    is_staging,
    environment: is_staging ? "staging" : "production",
    updated_at
  }
}

### PUT /merchants/:code/credentials
1. 從 body 讀取：ecpay_merchant_id, ecpay_hash_key, ecpay_hash_iv, environment
2. 輸入驗證：
   - ecpay_merchant_id: 必填，正則 /^\d{7,10}$/
   - ecpay_hash_key: 必填，正好 16 字元
   - ecpay_hash_iv: 必填，正好 16 字元
   - environment: 必填，只能是 "staging" 或 "production"
3. 加密 hash_key 和 hash_iv（用現有的 encrypt 函數）
4. UPDATE gateway_merchants SET:
   ecpay_merchant_id = 新值,
   ecpay_hash_key_encrypted = 加密後,
   ecpay_hash_iv_encrypted = 加密後,
   is_staging = (environment === 'staging'),
   updated_at = NOW()
   WHERE code = :code
5. 寫 audit_log：
   INSERT INTO audit_log (operator_id, operator_name, action, module, target_type, target_id, details)
   VALUES ('system', 'Gateway Admin API', 'update_payment_credentials', 'payment_credentials', 'gateway_merchants', :code, JSON details)
   details 包含：{ merchant_id: 新值, environment, source_ip: req.adminIp, timestamp }
   ❌ 不記錄 hash_key / hash_iv 的值
6. 回傳遮罩後的確認

### POST /merchants/:code/switch-env
1. body: { target_environment: "staging"|"production", confirm: true }
2. confirm !== true → 400 "Confirmation required"
3. 查 gateway_merchants 當前 is_staging
4. UPDATE is_staging = (target_environment === 'staging')
5. 寫 audit_log：action = 'switch_payment_environment'
   details: { from, to, source_ip }
6. 回傳 { success, previous_environment, current_environment }

### POST /merchants/:code/test-credentials
1. 查 gateway_merchants，解密憑證
2. 構建 ECPay QueryTradeInfo 請求：
   - MerchantID: merchant.ecpay_merchant_id
   - MerchantTradeNo: 'TEST' + Date.now() （一定不存在的單號）
   - TimeStamp: Math.floor(Date.now() / 1000)
   - CheckMacValue: 用 SHA256 算（金流用 SHA256）
3. POST 到 ECPay：
   - staging: https://payment-stage.ecpay.com.tw/Cashier/QueryTradeInfo/V5
   - production: https://payment.ecpay.com.tw/Cashier/QueryTradeInfo/V5
4. 解析回傳：
   - 如果包含 "查無此筆交易" 或 TradeStatus 回傳某種值 → 憑證有效（能連上）
   - 如果包含 "CheckMacValue" 或 "驗證錯誤" → 憑證無效
   - 其他錯誤 → 回傳原始訊息
5. 回傳 { valid: true/false, message: "..." }

遮罩函數（在 admin.js 內或 utils）：
function maskSecret(value) {
  if (!value) return '(not set)';
  const len = value.length;
  if (len <= 4) return '*'.repeat(len);
  if (len <= 8) return value.slice(0, 2) + '****' + value.slice(-2);
  return value.slice(0, 4) + '****' + value.slice(-4);
}
```

### Step 3：掛載路由

```
在 src/index.js（或 src/app.js，看主要的 Express app 設定檔）：

1. const adminRoutes = require('./routes/admin');
2. app.use('/api/v1/admin', adminRoutes);

放在現有的 payment 和 logistics 路由之後。

同時確認 CORS 設定允許 CMS domain：
在 CORS allowedOrigins 中加入 'https://admin.astrapath-marketing.com'
（如果還沒有的話）
```

### Step 4：測試

```
部署到 Railway 後，用 curl 測試：

# 1. 查詢憑證
curl -s "https://ecpay-gateway-production.up.railway.app/api/v1/admin/merchants/minjie/credentials" \
  -H "x-admin-api-key: $ADMIN_API_KEY" | jq

# 2. 測試連線
curl -s -X POST "https://ecpay-gateway-production.up.railway.app/api/v1/admin/merchants/minjie/test-credentials" \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' | jq

4 個端點都回 200 才進入 Phase 2。
```

---

## Phase 2：CMS API Routes + UI（在 cms-admin repo 執行）

### Step 5：新增環境變數

```
在 .env.local 加入：
GATEWAY_ADMIN_API_KEY=（跟 Railway ecpay-gateway 的 ADMIN_API_KEY 相同值）

在 .env.example 也加入（不含值）：
GATEWAY_ADMIN_API_KEY=

部署時記得在 Vercel 也設定這個環境變數。
```

### Step 6：建立 CMS API Routes

```
建立 3 個 API route，作為 CMS → Gateway 的 proxy：

### app/api/payment-credentials/route.ts

GET handler:
1. 驗證 CMS session（用現有的 session 驗證邏輯，參考其他 app/api/ route 的做法）
2. 從 searchParams 取 merchant_code（預設 'minjie'）
3. fetch GET ${ECPAY_GATEWAY_URL}/api/v1/admin/merchants/${merchant_code}/credentials
   Headers: { 'x-admin-api-key': process.env.GATEWAY_ADMIN_API_KEY }
4. 回傳 Gateway 的回應

PUT handler:
1. 驗證 CMS session
2. 從 body 取得 { merchant_code, ecpay_merchant_id, ecpay_hash_key, ecpay_hash_iv, environment }
3. fetch PUT ${ECPAY_GATEWAY_URL}/api/v1/admin/merchants/${merchant_code}/credentials
   Headers: { 'x-admin-api-key': ..., 'Content-Type': 'application/json' }
   Body: { ecpay_merchant_id, ecpay_hash_key, ecpay_hash_iv, environment }
4. 如果成功，也寫一筆 CMS 的 audit_log（用 Supabase service_role）
5. 回傳結果

### app/api/payment-credentials/switch/route.ts

POST handler:
1. 驗證 CMS session
2. body: { merchant_code, target_environment, confirm }
3. proxy 到 Gateway POST /admin/merchants/:code/switch-env
4. 如果需要同時切換金流+物流，對三個 merchant code 都呼叫：
   - minjie（金流）
   - minjie-logistics（B2C 物流）
   - minjie-c2c（C2C 物流）
5. 寫 CMS audit_log
6. 回傳結果

### app/api/payment-credentials/test/route.ts

POST handler:
1. 驗證 CMS session
2. body: { merchant_code }
3. proxy 到 Gateway POST /admin/merchants/:code/test-credentials
4. 回傳 { valid, message }

環境變數：
- ECPAY_GATEWAY_URL 已存在
- GATEWAY_ADMIN_API_KEY 是新加的
```

### Step 7：商家設定頁 — 金流設定 UI

```
修改商家設定頁面（找到 app/s/[token]/settings/page.tsx 或相近路徑），
在「LINE OA 設定」區塊之後、「功能開關」區塊之前，新增「金流設定」區塊。

UI 元件需求：

1. PaymentCredentialsSection 元件
   - 載入時 fetch GET /api/payment-credentials?merchant_code=minjie
   - 顯示目前的環境狀態：
     🟢 正式環境 (Production) 或 🟡 測試環境 (Staging)
   - 分三個卡片顯示三個 merchant（minjie / minjie-logistics / minjie-c2c）：
     每個卡片顯示：商店代號、HashKey（遮罩）、HashIV（遮罩）
   - 每個卡片有 [更新憑證] 和 [測試連線] 按鈕

2. UpdateCredentialsModal
   - 標題：更新金流憑證（{merchant_code}）
   - 警告文字：「⚠️ 請確認您的 ECPay 商店憑證正確，錯誤的憑證將導致付款功能異常。」
   - 表單欄位：
     - 商店代號 (MerchantID)：text input
     - HashKey：password input，附 👁 顯示/隱藏按鈕
     - HashIV：password input，附 👁 顯示/隱藏按鈕
   - Checkbox：「我確認以上憑證正確無誤」（必須勾選才能儲存）
   - 按鈕：[取消] [儲存憑證]
   - 儲存時 PUT /api/payment-credentials

3. SwitchEnvironmentModal
   - 標題：⚠️ 切換金流環境
   - 顯示：「您即將從 {current} 切換到 {target}」
   - 說明切換影響（新交易用新環境、進行中不受影響）
   - 輸入框：「請輸入『確認切換』以繼續」
   - 只有輸入正確文字才能點 [確認切換]
   - 確認後 POST /api/payment-credentials/switch
     body: { merchant_code: 'minjie', target_environment, confirm: true }
     （同時對三個 merchant 都切換）

4. 測試連線按鈕
   - 點擊後 POST /api/payment-credentials/test
   - 顯示 loading → 成功 ✅ 或失敗 ❌ 訊息
   - 結果用 toast 或 inline 顯示

UI 風格：跟現有的商家設定頁保持一致（黑金主題，跟其他區塊相同的卡片樣式）。
```

### Step 8：部署 + 測試

```
1. CMS 部署：
   cd "O:\project\cms-admin"
   npx vercel --prod

2. 在 Vercel 設定環境變數 GATEWAY_ADMIN_API_KEY

3. 開啟 CMS → 商家設定 → 確認金流設定區塊顯示正確

4. 測試流程：
   a. 查看遮罩憑證 → 確認 MerchantID 顯示
   b. 點「測試連線」→ 確認回傳有效
   c. 點「更新憑證」→ 填入 production 憑證 → 儲存
   d. 再次「測試連線」→ 確認新憑證有效
   e. 點「切換至正式環境」→ 輸入確認文字 → 切換
   f. 確認環境狀態變更為 🟢 正式環境
   g. 檢查修改紀錄頁 → 確認 audit log 有記錄
```

---

## 重要注意事項

1. **找加密函數**：Gateway 中已有 encrypt/decrypt 函數，用在建立商家時加密 hash_key/hash_iv。先 grep `encrypt` 或 `decrypt` 找到位置，直接 import 使用。

2. **找 Supabase client**：Gateway 中已有 Supabase client 設定（用 service_role key），直接 import。

3. **audit_log 表結構**：參考 CMS 的 audit_log 表，欄位可能包含 operator_id, operator_name, action, module, target_type, target_id, details, created_at。先確認實際欄位再 INSERT。

4. **不要動現有的付款流程**：admin.js 是完全新增的檔案，不修改 payment.js 或 logistics.js 的任何邏輯。

5. **CORS**：確認 Gateway 的 CORS 設定允許 `https://admin.astrapath-marketing.com`。

6. **三個 merchant 環境要一致**：環境切換 API 只切單一 merchant，但 CMS 的切換按鈕要同時呼叫三次（金流 + B2C物流 + C2C物流），確保一致。
