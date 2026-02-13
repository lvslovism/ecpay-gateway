/**
 * 物流 API - 超商取貨
 */
const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { decrypt } = require('../services/crypto');
const { authMiddleware } = require('../middleware/auth');
const {
  generateLogisticsTradeNo,
  generateCvsMapParams,
  generateCreateShipmentParams,
  generateMapFormHtml,
  generateCheckMacValue,
  verifyCheckMacValue,
  parseLogisticsStatus,
  getApiUrl
} = require('../services/ecpay-logistics');

/**
 * POST /api/v1/logistics/cvs-map
 * 取得超商地圖選店 URL
 */
router.post('/cvs-map', authMiddleware, async (req, res) => {
  try {
    const { cvs_type = 'UNIMART', is_collection = false, extra_data = '', return_url = '' } = req.body;
    const merchant = req.merchant;

    const gatewayUrl = process.env.GATEWAY_URL || `https://${req.get('host')}`;
    const callbackUrl = `${gatewayUrl}/api/v1/logistics/cvs-map/callback`;

    // 將 return_url 存入 extra_data（JSON 格式）
    const storedExtraData = JSON.stringify({ return_url, original: extra_data });

    const { params, tradeNo } = generateCvsMapParams(merchant, {
      cvs_type,
      is_collection,
      extra_data
    }, callbackUrl);

    const { error: insertError } = await supabase
      .from('gateway_cvs_selections')
      .insert({
        merchant_id: merchant.id,
        temp_trade_no: tradeNo,
        cvs_sub_type: cvs_type,
        extra_data: storedExtraData,
        expires_at: new Date(Date.now() + 30 * 60 * 1000)
      });

    if (insertError) throw insertError;

    const mapUrl = `${gatewayUrl}/api/v1/logistics/cvs-map/${tradeNo}`;

    res.json({
      success: true,
      temp_trade_no: tradeNo,
      map_url: mapUrl,
      expires_in: 1800
    });

  } catch (error) {
    console.error('CVS map error:', error);
    res.status(500).json({ error: 'Failed to generate CVS map URL' });
  }
});

/**
 * GET /api/v1/logistics/cvs-map/:tradeNo
 * 跳轉到綠界超商地圖頁面
 */
router.get('/cvs-map/:tradeNo', async (req, res) => {
  try {
    const { tradeNo } = req.params;
    
    const { data: selection, error } = await supabase
      .from('gateway_cvs_selections')
      .select('*, gateway_merchants(*)')
      .eq('temp_trade_no', tradeNo)
      .eq('is_used', false)
      .single();
    
    if (error || !selection) {
      return res.status(404).send('<h1>連結已過期或不存在</h1>');
    }
    
    const merchant = selection.gateway_merchants;
    const gatewayUrl = process.env.GATEWAY_URL || `https://${req.get('host')}`;
    const callbackUrl = `${gatewayUrl}/api/v1/logistics/cvs-map/callback`;
    
    const params = {
      MerchantID: merchant.ecpay_merchant_id,
      MerchantTradeNo: tradeNo,
      LogisticsType: 'CVS',
      LogisticsSubType: selection.cvs_sub_type || 'UNIMARTC2C',
      IsCollection: selection.extra_data?.includes('collection') ? 'Y' : 'N',
      ServerReplyURL: callbackUrl,
      ExtraData: selection.extra_data || ''
    };
    
    const formHtml = generateMapFormHtml(params, merchant.is_staging);
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(formHtml);
    
  } catch (error) {
    console.error('CVS map redirect error:', error);
    res.status(500).send('<h1>系統錯誤</h1>');
  }
});

/**
 * POST /api/v1/logistics/cvs-map/callback
 * 超商地圖選店回調
 */
router.post('/cvs-map/callback', async (req, res) => {
  try {
    console.log('CVS map callback:', req.body);

    const {
      MerchantTradeNo,
      CVSStoreID,
      CVSStoreName,
      CVSAddress,
      CVSTelephone,
      LogisticsSubType
    } = req.body;

    // 更新門市資料
    await supabase
      .from('gateway_cvs_selections')
      .update({
        cvs_store_id: CVSStoreID,
        cvs_store_name: CVSStoreName,
        cvs_address: CVSAddress,
        cvs_telephone: CVSTelephone || null,
        cvs_sub_type: LogisticsSubType
      })
      .eq('temp_trade_no', MerchantTradeNo);

    // 取得 extra_data 以解析 return_url
    const { data: selection } = await supabase
      .from('gateway_cvs_selections')
      .select('extra_data')
      .eq('temp_trade_no', MerchantTradeNo)
      .single();

    let returnUrl = '';
    if (selection?.extra_data) {
      try {
        const parsed = JSON.parse(selection.extra_data);
        returnUrl = parsed.return_url || '';
      } catch (e) {
        // extra_data 不是 JSON，忽略
      }
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>門市選擇完成</title>
  <style>
    body { font-family: sans-serif; text-align: center; padding: 50px; }
    .success { color: green; }
    .store-info { margin: 20px 0; padding: 20px; background: #f5f5f5; border-radius: 8px; }
  </style>
</head>
<body>
  <h1 class="success">✓ 門市選擇完成</h1>
  <div class="store-info">
    <p><strong>門市：</strong>${CVSStoreName}</p>
    <p><strong>地址：</strong>${CVSAddress}</p>
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage({
        type: 'CVS_STORE_SELECTED',
        data: {
          tempTradeNo: '${MerchantTradeNo}',
          storeId: '${CVSStoreID}',
          storeName: '${CVSStoreName}',
          address: '${CVSAddress}'
        }
      }, '*');
      setTimeout(() => window.close(), 2000);
    } else {
      const returnUrl = '${returnUrl}';
      if (returnUrl) {
        document.querySelector('p:last-child').textContent = '即將返回結帳頁...';
        setTimeout(() => { window.location.href = returnUrl; }, 2000);
      }
    }
  </script>
  <p>此視窗將自動關閉...</p>
</body>
</html>`);

  } catch (error) {
    console.error('CVS callback error:', error);
    res.status(500).send('<h1>處理失敗</h1>');
  }
});

/**
 * GET /api/v1/logistics/cvs-selection/:tradeNo
 * 查詢超商選店結果
 */
router.get('/cvs-selection/:tradeNo', authMiddleware, async (req, res) => {
  try {
    const { tradeNo } = req.params;
    
    const { data, error } = await supabase
      .from('gateway_cvs_selections')
      .select('*')
      .eq('temp_trade_no', tradeNo)
      .eq('merchant_id', req.merchant.id)
      .single();
    
    if (error || !data) {
      return res.status(404).json({ error: 'Selection not found' });
    }
    
    res.json({
      success: true,
      selection: {
        temp_trade_no: data.temp_trade_no,
        store_id: data.cvs_store_id,
        store_name: data.cvs_store_name,
        address: data.cvs_address,
        telephone: data.cvs_telephone,
        cvs_type: data.cvs_sub_type,
        is_used: data.is_used
      }
    });
    
  } catch (error) {
    console.error('Get CVS selection error:', error);
    res.status(500).json({ error: 'Failed to get selection' });
  }
});

/**
 * POST /api/v1/logistics/shipment
 * 建立超商物流單
 */
router.post('/shipment', authMiddleware, async (req, res) => {
  try {
    const {
      temp_trade_no,
      goods_name,
      goods_amount = 1,
      sender_name = '敏捷商店',
      sender_phone,
      sender_cellphone,
      receiver_name,
      receiver_phone,
      receiver_cellphone,
      receiver_email,
      receiver_store_id,
      cvs_sub_type,
      is_collection = false,
      collection_amount = 0,
      order_id,
      transaction_id
    } = req.body;
    
    const merchant = req.merchant;
    
    let storeId = receiver_store_id;
    let subType = cvs_sub_type;
    let storeName = null;
    
    if (temp_trade_no && !storeId) {
      const { data: selection } = await supabase
        .from('gateway_cvs_selections')
        .select('*')
        .eq('temp_trade_no', temp_trade_no)
        .eq('merchant_id', merchant.id)
        .eq('is_used', false)
        .single();
      
      if (selection && selection.cvs_store_id) {
        storeId = selection.cvs_store_id;
        subType = subType || selection.cvs_sub_type;
        storeName = selection.cvs_store_name;
        
        await supabase
          .from('gateway_cvs_selections')
          .update({ is_used: true })
          .eq('id', selection.id);
      }
    }
    
    if (!storeId) {
      return res.status(400).json({ error: 'receiver_store_id is required' });
    }
    if (!subType) {
      return res.status(400).json({ error: 'cvs_sub_type is required (UNIMARTC2C, FAMIC2C, HILIFEC2C)' });
    }
    if (!receiver_name) {
      return res.status(400).json({ error: 'receiver_name is required' });
    }
    
    // 解密憑證
    const hashKey = decrypt(merchant.ecpay_hash_key_encrypted);
    const hashIv = decrypt(merchant.ecpay_hash_iv_encrypted);
    
    const gatewayUrl = process.env.GATEWAY_URL || `https://${req.get('host')}`;
    
    const { params, tradeNo } = generateCreateShipmentParams(merchant, {
      goods_name,
      goods_amount,
      sender_name,
      sender_phone,
      sender_cellphone,
      receiver_name,
      receiver_phone,
      receiver_cellphone: receiver_cellphone || receiver_phone,
      receiver_email,
      receiver_store_id: storeId,
      cvs_sub_type: subType,
      is_collection,
      collection_amount,
      server_reply_url: `${gatewayUrl}/api/v1/logistics/webhook`
    }, hashKey, hashIv);
    
    const apiUrl = getApiUrl('create', merchant.is_staging);
    const formBody = new URLSearchParams(params).toString();

    console.log('Creating shipment:', { tradeNo, storeId, apiUrl });

    // BUG FIX: INSERT first with 'pending' status to avoid webhook timing issue
    // ECPay webhook can arrive before this API returns, so record must exist first
    const { data: pendingShipment, error: insertError } = await supabase
      .from('gateway_shipments')
      .insert({
        merchant_id: merchant.id,
        transaction_id: transaction_id || null,
        merchant_trade_no: tradeNo,
        logistics_type: 'CVS',
        logistics_sub_type: subType,
        receiver_name,
        receiver_phone: receiver_phone || receiver_cellphone,
        receiver_store_id: storeId,
        receiver_store_name: storeName,
        sender_name,
        sender_phone: sender_phone || sender_cellphone,
        status: 'pending',  // Will be updated after ECPay responds
        goods_name,
        goods_amount,
        cod_amount: is_collection ? collection_amount : 0,
        order_id: order_id || null
      })
      .select()
      .single();

    if (insertError) {
      console.error('Failed to create pending shipment:', insertError);
      throw insertError;
    }

    console.log('Created pending shipment:', pendingShipment.id);

    // Now call ECPay API
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody
    });

    const responseText = await response.text();
    console.log('ECPay response:', responseText);

    const ecpayResult = {};
    responseText.split('&').forEach(pair => {
      const [key, value] = pair.split('=');
      if (key) ecpayResult[key] = decodeURIComponent(value || '');
    });

    // BUG FIX: Accept RtnCode 2001 as success for C2C shipments
    // RtnCode meanings: '1' = B2C success, '300' = some operations, '2001' = C2C success
    const isSuccess = ecpayResult.RtnCode === '1' ||
                      ecpayResult.RtnCode === '300' ||
                      ecpayResult.RtnCode === '2001';

    if (!isSuccess) {
      // Update shipment to failed status
      await supabase
        .from('gateway_shipments')
        .update({
          status: 'failed',
          ecpay_response: ecpayResult,
          status_message: ecpayResult.RtnMsg
        })
        .eq('id', pendingShipment.id);

      return res.status(400).json({
        error: 'ECPay create shipment failed',
        code: ecpayResult.RtnCode,
        message: ecpayResult.RtnMsg
      });
    }

    // Update shipment with ECPay response data
    const { data: shipment, error: updateError } = await supabase
      .from('gateway_shipments')
      .update({
        all_pay_logistics_id: ecpayResult.AllPayLogisticsID || ecpayResult['1|AllPayLogisticsID'],
        cvs_payment_no: ecpayResult.CVSPaymentNo,
        cvs_validation_no: ecpayResult.CVSValidationNo,
        status: 'created',
        ecpay_response: ecpayResult
      })
      .eq('id', pendingShipment.id)
      .select()
      .single();

    if (updateError) {
      console.error('Failed to update shipment with ECPay data:', updateError);
      throw updateError;
    }
    
    // Return shipment data from the updated record (has correct values)
    res.json({
      success: true,
      shipment: {
        id: shipment.id,
        merchant_trade_no: shipment.merchant_trade_no,
        all_pay_logistics_id: shipment.all_pay_logistics_id,
        cvs_payment_no: shipment.cvs_payment_no,
        cvs_validation_no: shipment.cvs_validation_no,
        status: shipment.status
      }
    });
    
  } catch (error) {
    console.error('Create shipment error:', error);
    res.status(500).json({ error: 'Failed to create shipment' });
  }
});

/**
 * POST /api/v1/logistics/webhook
 * 物流狀態更新回調
 */
router.post('/webhook', async (req, res) => {
  try {
    console.log('Logistics webhook:', req.body);
    
    const { MerchantTradeNo, RtnCode, RtnMsg, AllPayLogisticsID } = req.body;
    
    const { data: shipment, error: queryError } = await supabase
      .from('gateway_shipments')
      .select('*, gateway_merchants(*)')
      .eq('merchant_trade_no', MerchantTradeNo)
      .single();
    
    if (queryError || !shipment) {
      console.error('Shipment not found:', MerchantTradeNo);
      return res.send('0|Shipment not found');
    }
    
    const merchant = shipment.gateway_merchants;
    const hashKey = decrypt(merchant.ecpay_hash_key_encrypted);
    const hashIv = decrypt(merchant.ecpay_hash_iv_encrypted);
    
    const isValid = verifyCheckMacValue(req.body, hashKey, hashIv);
    
    await supabase.from('gateway_webhook_logs').insert({
      merchant_id: merchant.id,
      shipment_id: shipment.id,
      type: 'logistics',
      source_ip: req.ip,
      raw_body: JSON.stringify(req.body),
      check_mac_valid: isValid,
      processed: true
    });
    
    if (!isValid) {
      console.error('Invalid CheckMacValue');
      return res.send('0|CheckMacValue Error');
    }
    
    const status = parseLogisticsStatus(RtnCode);
    const updateData = {
      status,
      status_message: RtnMsg,
      updated_at: new Date()
    };
    
    if (status === 'shipping') updateData.shipped_at = new Date();
    if (status === 'arrived') updateData.arrived_at = new Date();
    if (status === 'picked_up') updateData.picked_up_at = new Date();
    
    await supabase
      .from('gateway_shipments')
      .update(updateData)
      .eq('id', shipment.id);
    
    console.log(`Shipment ${MerchantTradeNo} → ${status}`);
    
    res.send('1|OK');
    
  } catch (error) {
    console.error('Logistics webhook error:', error);
    res.send('0|Error');
  }
});

/**
 * GET /api/v1/logistics/shipment/:id
 * 查詢物流單
 */
router.get('/shipment/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: shipment, error } = await supabase
      .from('gateway_shipments')
      .select('*')
      .eq('id', id)
      .eq('merchant_id', req.merchant.id)
      .single();
    
    if (error || !shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }
    
    res.json({ success: true, shipment });
    
  } catch (error) {
    console.error('Get shipment error:', error);
    res.status(500).json({ error: 'Failed to get shipment' });
  }
});

/**
 * GET /api/v1/logistics/shipments
 * 列出物流單
 */
router.get('/shipments', authMiddleware, async (req, res) => {
  try {
    const { status, order_id, limit = 20, offset = 0 } = req.query;
    
    let query = supabase
      .from('gateway_shipments')
      .select('*', { count: 'exact' })
      .eq('merchant_id', req.merchant.id)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    
    if (status) query = query.eq('status', status);
    if (order_id) query = query.eq('order_id', order_id);
    
    const { data: shipments, count, error } = await query;
    
    if (error) throw error;
    
    res.json({ success: true, shipments, total: count });
    
  } catch (error) {
    console.error('List shipments error:', error);
    res.status(500).json({ error: 'Failed to list shipments' });
  }
});

/**
 * GET /api/v1/logistics/shipment/:id/print
 * 列印託運單 - 生成自動 POST 到 ECPay 的 HTML 表單
 */
router.get('/shipment/:id/print', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // 查物流單 + 商家資訊
    const { data: shipment, error } = await supabase
      .from('gateway_shipments')
      .select('*, gateway_merchants(*)')
      .eq('id', id)
      .eq('merchant_id', req.merchant.id)
      .single();

    if (error || !shipment) {
      return res.status(404).send('<h1>找不到物流單</h1>');
    }

    if (!shipment.all_pay_logistics_id || !shipment.cvs_payment_no) {
      return res.status(400).send('<h1>物流單資訊不完整，無法列印</h1>');
    }

    const merchant = shipment.gateway_merchants;
    const hashKey = decrypt(merchant.ecpay_hash_key_encrypted);
    const hashIv = decrypt(merchant.ecpay_hash_iv_encrypted);

    // 根據超商類型決定列印 URL
    const printUrls = {
      UNIMARTC2C: {
        staging: 'https://logistics-stage.ecpay.com.tw/Express/PrintUniMartC2COrderInfo',
        production: 'https://logistics.ecpay.com.tw/Express/PrintUniMartC2COrderInfo'
      },
      FAMIC2C: {
        staging: 'https://logistics-stage.ecpay.com.tw/Express/PrintFAMIC2COrderInfo',
        production: 'https://logistics.ecpay.com.tw/Express/PrintFAMIC2COrderInfo'
      },
      HILIFEC2C: {
        staging: 'https://logistics-stage.ecpay.com.tw/Express/PrintHILIFEC2COrderInfo',
        production: 'https://logistics.ecpay.com.tw/Express/PrintHILIFEC2COrderInfo'
      }
    };

    const subType = shipment.logistics_sub_type;
    const urlConfig = printUrls[subType];
    if (!urlConfig) {
      return res.status(400).send('<h1>不支援的物流類型：' + subType + '</h1>');
    }

    const env = merchant.is_staging ? 'staging' : 'production';
    const printUrl = urlConfig[env];

    // 組裝參數
    const params = {
      MerchantID: String(merchant.ecpay_merchant_id),
      AllPayLogisticsID: String(shipment.all_pay_logistics_id),
      CVSPaymentNo: String(shipment.cvs_payment_no),
      PlatformID: ''
    };

    // 7-11 需要額外的 CVSValidationNo
    if (subType === 'UNIMARTC2C') {
      params.CVSValidationNo = String(shipment.cvs_validation_no || '');
    }

    // 計算 CheckMacValue (物流用 MD5)
    params.CheckMacValue = generateCheckMacValue(params, hashKey, hashIv, 'md5');

    // 生成自動提交表單 HTML
    let formInputs = '';
    Object.entries(params).forEach(([key, value]) => {
      formInputs += `    <input type="hidden" name="${key}" value="${value}">\n`;
    });

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>列印託運單</title>
</head>
<body>
  <p>正在導向綠界列印頁面...</p>
  <form id="print-form" method="POST" action="${printUrl}">
${formInputs}  </form>
  <script>document.getElementById("print-form").submit();</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);

  } catch (error) {
    console.error('Print shipment label error:', error);
    res.status(500).send('<h1>列印託運單失敗</h1>');
  }
});

/**
 * POST /api/v1/logistics/shipment/batch-print
 * 批量列印託運單 - 支援多筆物流單同時列印
 */
router.post('/shipment/batch-print', authMiddleware, async (req, res) => {
  try {
    const { shipment_ids } = req.body;
    if (!shipment_ids || !Array.isArray(shipment_ids) || shipment_ids.length === 0) {
      return res.status(400).json({ error: 'shipment_ids is required' });
    }

    const merchant = req.merchant;

    // 查詢所有 shipments
    const { data: shipments, error: queryError } = await supabase
      .from('gateway_shipments')
      .select('*')
      .in('id', shipment_ids)
      .eq('merchant_id', merchant.id)
      .eq('status', 'created')
      .not('all_pay_logistics_id', 'is', null);

    if (queryError) throw queryError;

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

      // 計算 CheckMacValue (MD5)
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
    <button class="btn-print" onclick="window.print()">列印全部</button>
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

module.exports = router;
