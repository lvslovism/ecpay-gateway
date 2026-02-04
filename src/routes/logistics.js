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
    const { cvs_type = 'UNIMART', is_collection = false, extra_data = '' } = req.body;
    const merchant = req.merchant;
    
    const gatewayUrl = process.env.GATEWAY_URL || `https://${req.get('host')}`;
    const callbackUrl = `${gatewayUrl}/api/v1/logistics/cvs-map/callback`;
    
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
        extra_data,
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
    
    if (ecpayResult.RtnCode !== '300' && ecpayResult.RtnCode !== '1') {
      return res.status(400).json({
        error: 'ECPay create shipment failed',
        code: ecpayResult.RtnCode,
        message: ecpayResult.RtnMsg
      });
    }
    
    const { data: shipment, error: insertError } = await supabase
      .from('gateway_shipments')
      .insert({
        merchant_id: merchant.id,
        transaction_id: transaction_id || null,
        merchant_trade_no: tradeNo,
        all_pay_logistics_id: ecpayResult.AllPayLogisticsID || ecpayResult['1|AllPayLogisticsID'],
        logistics_type: 'CVS',
        logistics_sub_type: subType,
        cvs_payment_no: ecpayResult.CVSPaymentNo,
        cvs_validation_no: ecpayResult.CVSValidationNo,
        receiver_name,
        receiver_phone: receiver_phone || receiver_cellphone,
        receiver_store_id: storeId,
        receiver_store_name: storeName,
        sender_name,
        sender_phone: sender_phone || sender_cellphone,
        status: 'created',
        goods_name,
        goods_amount,
        cod_amount: is_collection ? collection_amount : 0,
        order_id: order_id || null,
        ecpay_response: ecpayResult
      })
      .select()
      .single();
    
    if (insertError) throw insertError;
    
    res.json({
      success: true,
      shipment: {
        id: shipment.id,
        merchant_trade_no: tradeNo,
        all_pay_logistics_id: ecpayResult.AllPayLogisticsID,
        cvs_payment_no: ecpayResult.CVSPaymentNo,
        cvs_validation_no: ecpayResult.CVSValidationNo,
        status: 'created'
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

module.exports = router;
