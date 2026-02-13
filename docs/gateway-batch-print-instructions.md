# ECPay Gateway — 新增批量列印託運單端點

> 在 ecpay-gateway 專案執行

## 背景

目前已有單筆列印端點 `GET /api/v1/logistics/shipment/:id/print`，它會：
1. 查 gateway_shipments 取得 AllPayLogisticsID、CVSPaymentNo、CVSValidationNo
2. 查 gateway_merchants 取得加密的 HashKey/HashIV 並解密
3. 計算 CheckMacValue (MD5)
4. 生成自動 POST 表單 HTML → 導向 ECPay 官方列印頁面

現在需要新增**批量列印**端點，ECPay 原生支援批次列印：
- AllPayLogisticsID 用逗號分隔（如 `3422307,3422310,3422328`）
- CVSPaymentNo 用逗號分隔（如 `D8791141,D8791143,D8791166`）
- 7-11 的 CVSValidationNo 也用逗號分隔
- **不同超商不能混在一次列印**，必須分開呼叫

## ECPay C2C 列印 API URL

測試環境：
- 7-11: `https://logistics-stage.ecpay.com.tw/Express/PrintUniMartC2COrderInfo`
- 全家: `https://logistics-stage.ecpay.com.tw/Express/PrintFAMIC2COrderInfo`
- 萊爾富: `https://logistics-stage.ecpay.com.tw/Express/PrintHILIFEC2COrderInfo`

正式環境：
- 7-11: `https://logistics.ecpay.com.tw/Express/PrintUniMartC2COrderInfo`
- 全家: `https://logistics.ecpay.com.tw/Express/PrintFAMIC2COrderInfo`
- 萊爾富: `https://logistics.ecpay.com.tw/Express/PrintHILIFEC2COrderInfo`

## 必要參數

所有超商共用：
- MerchantID (字串)
- AllPayLogisticsID (逗號分隔)
- CVSPaymentNo (逗號分隔)
- CheckMacValue (MD5)

7-11 額外需要：
- CVSValidationNo (逗號分隔)

全家和萊爾富不需要 CVSValidationNo。

## 新增端點

### `POST /api/v1/logistics/shipment/batch-print`

在 `src/routes/logistics.js` 新增，放在現有的 `GET /shipment/:id/print` 端點之後、`module.exports` 之前。

**請求格式：**
```json
{
  "shipment_ids": ["uuid1", "uuid2", "uuid3"]
}
```

**處理邏輯：**

```
1. 驗證 API Key → 取得 merchant
2. 查 gateway_shipments WHERE id IN (shipment_ids) AND merchant_id = merchant.id AND status = 'created'
3. 過濾掉沒有 all_pay_logistics_id 的記錄
4. 按 logistics_sub_type 分組：UNIMARTC2C / FAMIC2C / HILIFEC2C
5. 對每個分組：
   a. 用逗號組合 AllPayLogisticsID, CVSPaymentNo, CVSValidationNo
   b. 計算 CheckMacValue (MD5)
   c. 生成一個 <form> 自動 POST 到對應的 ECPay 列印 URL
6. 回傳 HTML 頁面，包含：
   - 頂部操作列（列印按鈕、關閉按鈕、共 N 筆）
   - 每個超商分組一個 <iframe>，各自載入 ECPay 列印結果
   - 操作列 @media print 時隱藏
```

**重要：ECPay 列印 API 是 POST form submit 會回傳 HTML。不能用 fetch，必須用 iframe 或 form action。**

**實作方式：回傳一個 HTML 頁面，內含多個隱藏 form，每個 form target 到不同的 iframe。頁面載入後自動 submit 所有 form。**

```javascript
// 偽代碼
router.post('/shipment/batch-print', authenticate, async (req, res) => {
  try {
    const { shipment_ids } = req.body;
    if (!shipment_ids || !Array.isArray(shipment_ids) || shipment_ids.length === 0) {
      return res.status(400).json({ error: 'shipment_ids is required' });
    }

    const merchant = req.merchant;
    
    // 查詢所有 shipments
    const { data: shipments } = await supabase
      .from('gateway_shipments')
      .select('*')
      .in('id', shipment_ids)
      .eq('merchant_id', merchant.id)
      .eq('status', 'created')
      .not('all_pay_logistics_id', 'is', null);

    if (!shipments || shipments.length === 0) {
      return res.status(404).json({ error: 'No printable shipments found' });
    }

    // 解密憑證
    const hashKey = decrypt(merchant.ecpay_hash_key_encrypted);
    const hashIv = decrypt(merchant.ecpay_hash_iv_encrypted);
    const env = merchant.is_staging ? 'staging' : 'production';

    // 按超商分組
    const groups = {};
    for (const s of shipments) {
      const subType = s.logistics_sub_type;
      if (!groups[subType]) groups[subType] = [];
      groups[subType].push(s);
    }

    // ECPay 列印 URL 對照
    const printUrls = {
      staging: {
        UNIMARTC2C: 'https://logistics-stage.ecpay.com.tw/Express/PrintUniMartC2COrderInfo',
        FAMIC2C: 'https://logistics-stage.ecpay.com.tw/Express/PrintFAMIC2COrderInfo',
        HILIFEC2C: 'https://logistics-stage.ecpay.com.tw/Express/PrintHILIFEC2COrderInfo',
      },
      production: {
        UNIMARTC2C: 'https://logistics.ecpay.com.tw/Express/PrintUniMartC2COrderInfo',
        FAMIC2C: 'https://logistics.ecpay.com.tw/Express/PrintFAMIC2COrderInfo',
        HILIFEC2C: 'https://logistics.ecpay.com.tw/Express/PrintHILIFEC2COrderInfo',
      }
    };

    const cvsNames = {
      UNIMARTC2C: '7-ELEVEN',
      FAMIC2C: '全家',
      HILIFEC2C: '萊爾富'
    };

    // 為每個分組生成 form
    let formsHtml = '';
    let iframesHtml = '';
    let formIndex = 0;

    for (const [subType, groupShipments] of Object.entries(groups)) {
      const printUrl = printUrls[env]?.[subType];
      if (!printUrl) continue;

      const allPayLogisticsIDs = groupShipments.map(s => String(s.all_pay_logistics_id)).join(',');
      const cvsPaymentNos = groupShipments.map(s => String(s.cvs_payment_no)).join(',');

      const params = {
        MerchantID: String(merchant.ecpay_merchant_id),
        AllPayLogisticsID: allPayLogisticsIDs,
        CVSPaymentNo: cvsPaymentNos,
        PlatformID: ''
      };

      // 7-11 需要 CVSValidationNo
      if (subType === 'UNIMARTC2C') {
        params.CVSValidationNo = groupShipments.map(s => String(s.cvs_validation_no || '')).join(',');
      }

      // 計算 CheckMacValue (MD5) - 使用已有的 generateCheckMacValue 函數
      params.CheckMacValue = generateCheckMacValue(params, hashKey, hashIv, 'md5');

      const frameName = `frame_${formIndex}`;
      const formId = `form_${formIndex}`;

      // 生成隱藏 form
      let formInputs = '';
      for (const [key, value] of Object.entries(params)) {
        formInputs += `<input type="hidden" name="${key}" value="${value}">`;
      }

      formsHtml += `<form id="${formId}" method="POST" action="${printUrl}" target="${frameName}" style="display:none;">${formInputs}</form>`;

      // 生成 iframe 區塊
      iframesHtml += `
        <div class="cvs-group">
          <h2>${cvsNames[subType] || subType}（${groupShipments.length} 筆）</h2>
          <iframe name="${frameName}" style="width:100%;min-height:600px;border:1px solid #ccc;"></iframe>
        </div>`;

      formIndex++;
    }

    // 生成完整 HTML
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>批量列印託運單</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Microsoft JhengHei', sans-serif; background: #f5f5f5; }
    .toolbar {
      position: sticky; top: 0; z-index: 100;
      background: #1a1a1a; color: white; padding: 12px 24px;
      display: flex; align-items: center; gap: 16px;
    }
    .toolbar button {
      padding: 8px 20px; border: none; border-radius: 6px;
      font-size: 14px; cursor: pointer; font-weight: bold;
    }
    .btn-print { background: #D4AF37; color: #000; }
    .btn-print:hover { background: #E5C347; }
    .btn-close { background: #555; color: #fff; }
    .btn-close:hover { background: #777; }
    .toolbar span { font-size: 14px; color: #ccc; }
    .cvs-group { margin: 16px; }
    .cvs-group h2 {
      background: #fff; padding: 12px 16px; margin-bottom: 0;
      border: 1px solid #ddd; border-bottom: none;
      font-size: 16px;
    }
    .cvs-group iframe { display: block; }
    .loading { text-align: center; padding: 40px; color: #666; }
    @media print {
      .toolbar { display: none !important; }
      .cvs-group h2 { display: none !important; }
      .cvs-group { margin: 0; }
      .cvs-group iframe {
        width: 100%; border: none;
        page-break-after: always;
      }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button class="btn-print" onclick="window.print()">🖨️ 列印全部</button>
    <button class="btn-close" onclick="window.close()">關閉視窗</button>
    <span>共 ${shipments.length} 筆託運單</span>
    <span id="status">載入中...</span>
  </div>
  <div id="content">
    <div class="loading">正在從綠界載入託運單...</div>
  </div>
  ${formsHtml}
  ${iframesHtml}
  <script>
    // 自動 submit 所有 form
    window.addEventListener('load', function() {
      document.getElementById('content').style.display = 'none';
      ${Array.from({length: formIndex}, (_, i) => `document.getElementById('form_${i}').submit();`).join('\n      ')}
      document.getElementById('status').textContent = '載入完成';
    });
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);

  } catch (error) {
    console.error('Batch print error:', error);
    res.status(500).json({ error: 'Batch print failed' });
  }
});
```

**注意事項：**
1. `authenticate` middleware 和 `decrypt`、`generateCheckMacValue` 函數已在檔案中存在，直接使用
2. 放在 `module.exports = router;` 之前
3. 不要修改任何現有端點
4. 確認 supabase client 的引用方式跟現有端點一致

## 部署

```powershell
cd "C:\Users\Hotten\Projects\ecpay-gateway"
git add -A
git commit -m "feat: add batch print endpoint for ECPay C2C waybills"
git push
```

等 Railway 自動部署完成。
