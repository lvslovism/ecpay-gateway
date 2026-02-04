# ECPay Gateway

ECPay 金流物流閘道服務，為 Medusa 電商系統提供統一的支付和物流 API。

## 功能

- ✅ 金流：信用卡、ATM、超商代碼
- 🚧 物流：超商取貨、宅配（Phase 2）
- ✅ 多商家支援
- ✅ Webhook 自動通知

## 部署到 Railway

### 1. 建立 GitHub Repo

將此專案上傳到 GitHub。

### 2. Railway 連接

1. 登入 [Railway](https://railway.app)
2. New Project → Deploy from GitHub repo
3. 選擇此 repo

### 3. 設定環境變數

在 Railway Variables 設定：

```
SUPABASE_URL=https://ephdzjkgpkuydpbkxnfw.supabase.co
SUPABASE_SERVICE_KEY=<你的 service role key>
ENCRYPTION_KEY=<64 字元 hex>
ADMIN_API_KEY=<admin key>
GATEWAY_URL=https://<你的-railway-app>.up.railway.app
```

產生 ENCRYPTION_KEY：
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

產生 ADMIN_API_KEY：
```bash
node -e "console.log('admin_' + require('crypto').randomBytes(32).toString('hex'))"
```

### 4. 設定網域（選用）

Railway Settings → Networking → Generate Domain

## API 使用

### 建立商家

```bash
curl -X POST https://your-gateway.up.railway.app/api/v1/merchants \
  -H "Content-Type: application/json" \
  -H "x-api-key: admin_xxx" \
  -d '{
    "code": "minjie",
    "name": "敏捷商店",
    "ecpay_merchant_id": "3002607",
    "ecpay_hash_key": "pwFHCqoQZGmho4w6",
    "ecpay_hash_iv": "EkRm7iFT261dpevs",
    "success_url": "https://minjie0326.com/order-success",
    "failure_url": "https://minjie0326.com/order-failed",
    "webhook_url": "https://your-n8n.com/webhook/payment",
    "is_staging": true
  }'
```

回傳會包含 `api_key`（`gk_xxx`），請妥善保存。

### 建立結帳

```bash
curl -X POST https://your-gateway.up.railway.app/api/v1/payment/checkout \
  -H "Content-Type: application/json" \
  -H "x-api-key: gk_xxx" \
  -d '{
    "amount": 1000,
    "item_name": "測試商品",
    "order_id": "order_123",
    "customer_email": "test@example.com"
  }'
```

回傳：
```json
{
  "success": true,
  "checkout_url": "https://your-gateway.../checkout/xxx",
  "merchant_trade_no": "xxx",
  "expires_at": "..."
}
```

將用戶導向 `checkout_url` 即可進入 ECPay 付款頁面。

### 查詢交易

```bash
curl https://your-gateway.up.railway.app/api/v1/payment/transactions \
  -H "x-api-key: gk_xxx"
```

## 綠界測試憑證

如果沒有自己的測試商家，可使用公用測試憑證：

```
MerchantID: 3002607
HashKey: pwFHCqoQZGmho4w6
HashIV: EkRm7iFT261dpevs
```

## License

MIT
