# CLAUDE.md

ECPay 金流物流閘道服務，Express.js API server，為 Medusa 電商後端提供台灣在地支付和物流整合。

## Commands

```bash
npm run dev      # 開發模式（node --watch）
npm run start    # 正式啟動
```

無測試框架。

## Architecture

Express.js REST API，三條主要路由：

| Route | File | Purpose |
|-------|------|---------|
| `/api/payment/*` | `src/routes/payment.js` | ECPay 金流（信用卡、ATM、CVS 代碼） |
| `/api/logistics/*` | `src/routes/logistics.js` | ECPay 物流（超取、宅配、批次出貨） |
| `/api/merchants/*` | `src/routes/merchants.js` | 商家設定管理 |

### Key Files

- `src/index.js` — Express app entry point
- `src/middleware/auth.js` — 請求驗證 middleware
- `src/services/ecpay-payment.js` — ECPay 金流 SDK 封裝
- `src/services/ecpay-logistics.js` — ECPay 物流 SDK 封裝
- `src/services/crypto.js` — ECPay AES/SHA256 加解密
- `src/services/supabase.js` — Supabase DB 連線
- `ecpay-logistics.js` — 物流獨立模組（根目錄）
- `encrypt-credentials.js` — 憑證加密工具

## External Dependencies

| Service | Purpose |
|---------|---------|
| ECPay | 台灣金流（信用卡/ATM/CVS）+ 物流（超取/宅配） |
| Supabase | 訂單/商家資料儲存 |
| Medusa | 訂單來源（callback 通知） |

## Key Rules

- ECPay 回傳的 CheckMacValue 必須驗證
- 價格從 DB 取，不信任前端傳入的金額
- 物流狀態更新透過 ECPay callback webhook
- 批次出貨支援 C2C 超商寄件單列印
