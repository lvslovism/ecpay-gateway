const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');
const supabase = require('../services/supabase');
const { decrypt } = require('../services/crypto');
const { 
  generateCheckMacValue, 
  verifyCheckMacValue, 
  createPaymentParams, 
  generatePaymentForm 
} = require('../services/ecpay-payment');
const { authMiddleware } = require('../middleware/auth');

/**
 * POST /api/v1/payment/checkout
 * 建立結帳交易，回傳 checkout_url
 */
router.post('/checkout', authMiddleware, async (req, res) => {
  try {
    const merchant = req.merchant;
    const {
      amount,
      item_name,
      order_id,
      customer_email,
      customer_name,
      customer_phone,
      return_url, // 付款後客戶端跳轉
      metadata = {}
    } = req.body;

    // 驗證必填
    if (!amount || !item_name) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['amount', 'item_name']
      });
    }

    // 產生交易編號（ECPay 限制 20 字元，數字+英文）
    const timestamp = dayjs().format('YYMMDDHHmmss');
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    const merchantTradeNo = `${timestamp}${random}`;

    // 寫入資料庫
    const { data: transaction, error } = await supabase
      .from('gateway_transactions')
      .insert({
        merchant_id: merchant.id,
        merchant_trade_no: merchantTradeNo,
        amount: Math.round(amount), // 綠界只接受整數
        item_name,
        order_id,
        customer_email,
        customer_name,
        customer_phone,
        return_url,
        metadata,
        expires_at: dayjs().add(30, 'minute').toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error('Create transaction error:', error);
      return res.status(500).json({ error: 'Failed to create transaction' });
    }

    // 回傳 checkout URL（讓前端導向）
    const gatewayUrl = process.env.GATEWAY_URL || `https://${req.get('host')}`;
    const checkoutUrl = `${gatewayUrl}/api/v1/payment/checkout/${merchantTradeNo}`;

    res.status(201).json({
      success: true,
      transaction_id: transaction.id,
      merchant_trade_no: merchantTradeNo,
      checkout_url: checkoutUrl,
      expires_at: transaction.expires_at
    });

  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/payment/checkout/:merchantTradeNo
 * 付款頁面（自動提交到 ECPay）
 */
router.get('/checkout/:merchantTradeNo', async (req, res) => {
  try {
    const { merchantTradeNo } = req.params;

    // 查詢交易
    const { data: transaction, error } = await supabase
      .from('gateway_transactions')
      .select('*, gateway_merchants(*)')
      .eq('merchant_trade_no', merchantTradeNo)
      .single();

    if (error || !transaction) {
      return res.status(404).send('Transaction not found');
    }

    // 檢查狀態
    if (transaction.status !== 'pending') {
      return res.status(400).send('Transaction already processed');
    }

    // 檢查過期
    if (dayjs().isAfter(dayjs(transaction.expires_at))) {
      return res.status(400).send('Transaction expired');
    }

    const merchant = transaction.gateway_merchants;

    // 解密 ECPay 憑證
    const hashKey = decrypt(merchant.ecpay_hash_key_encrypted);
    const hashIV = decrypt(merchant.ecpay_hash_iv_encrypted);

    // Gateway URL（用於 ReturnURL）
    const gatewayUrl = process.env.GATEWAY_URL || `https://${req.get('host')}`;

    // 建立付款參數
    const params = createPaymentParams({
      merchantId: merchant.ecpay_merchant_id,
      merchantTradeNo: transaction.merchant_trade_no,
      totalAmount: transaction.amount,
      itemName: transaction.item_name,
      returnUrl: `${gatewayUrl}/api/v1/payment/webhook`, // ECPay 伺服器回呼
      clientBackUrl: merchant.success_url, // 用戶點「返回商店」
      orderResultUrl: `${gatewayUrl}/api/v1/payment/result` // 付款完成跳轉（經 Gateway 轉換為 GET）
    });

    // 計算 CheckMacValue
    const checkMacValue = generateCheckMacValue(params, hashKey, hashIV);

    // 產生自動提交表單
    const html = generatePaymentForm(params, checkMacValue, merchant.is_staging);

    res.setHeader('Content-Type', 'text/html');
    res.send(html);

  } catch (err) {
    console.error('Checkout page error:', err);
    res.status(500).send('Internal server error');
  }
});

/**
 * POST /api/v1/payment/result
 * ECPay 付款完成後跳轉（OrderResultURL）
 * 將 POST 轉換為 GET redirect，讓前端能讀取參數
 */
router.post('/result', async (req, res) => {
  try {
    const params = req.body;
    const merchantTradeNo = params.MerchantTradeNo;

    console.log('Payment result redirect:', merchantTradeNo);

    // 查詢交易取得 return_url
    const { data: transaction, error } = await supabase
      .from('gateway_transactions')
      .select('return_url, gateway_merchants(success_url)')
      .eq('merchant_trade_no', merchantTradeNo)
      .single();

    // 決定跳轉目標
    let redirectUrl = transaction?.return_url
      || transaction?.gateway_merchants?.success_url
      || '/';

    // 組合 query string（只傳必要參數）
    const queryParams = new URLSearchParams({
      MerchantTradeNo: params.MerchantTradeNo || '',
      RtnCode: params.RtnCode || '',
      RtnMsg: params.RtnMsg || '',
      TradeNo: params.TradeNo || '',
      TradeAmt: params.TradeAmt || '',
      PaymentDate: params.PaymentDate || '',
      PaymentType: params.PaymentType || ''
    });

    // 302 redirect
    const finalUrl = `${redirectUrl}?${queryParams.toString()}`;
    console.log('Redirecting to:', finalUrl);

    res.redirect(302, finalUrl);

  } catch (err) {
    console.error('Payment result redirect error:', err);
    res.status(500).send('Redirect failed');
  }
});

/**
 * POST /api/v1/payment/webhook
 * ECPay 付款結果回呼（無需認證，ECPay 伺服器呼叫）
 */
router.post('/webhook', async (req, res) => {
  try {
    const params = req.body;
    const merchantTradeNo = params.MerchantTradeNo;

    console.log('Payment webhook received:', merchantTradeNo);

    // 查詢交易
    const { data: transaction, error: txError } = await supabase
      .from('gateway_transactions')
      .select('*, gateway_merchants(*)')
      .eq('merchant_trade_no', merchantTradeNo)
      .single();

    if (txError || !transaction) {
      console.error('Transaction not found:', merchantTradeNo);
      return res.send('0|Transaction not found');
    }

    const merchant = transaction.gateway_merchants;

    // 解密憑證
    const hashKey = decrypt(merchant.ecpay_hash_key_encrypted);
    const hashIV = decrypt(merchant.ecpay_hash_iv_encrypted);

    // 驗證 CheckMacValue
    const isValid = verifyCheckMacValue(params, hashKey, hashIV);

    // 記錄 Webhook
    await supabase.from('gateway_webhook_logs').insert({
      merchant_id: merchant.id,
      transaction_id: transaction.id,
      type: 'payment',
      source_ip: req.ip,
      raw_body: JSON.stringify(params),
      check_mac_valid: isValid
    });

    if (!isValid) {
      console.error('Invalid CheckMacValue for:', merchantTradeNo);
      return res.send('0|CheckMacValue verification failed');
    }

    // 更新交易狀態
    const rtnCode = params.RtnCode;
    const isSuccess = rtnCode === '1';

    const updateData = {
      ecpay_trade_no: params.TradeNo,
      payment_type: params.PaymentType,
      ecpay_response: params
    };

    if (isSuccess) {
      updateData.status = 'authorized';
      updateData.authorized_at = new Date().toISOString();
      updateData.card_last4 = params.card4no || null;
      updateData.auth_code = params.auth_code || null;
    } else {
      updateData.status = 'failed';
      updateData.failed_at = new Date().toISOString();
      updateData.error_code = rtnCode;
      updateData.error_message = params.RtnMsg;
    }

    await supabase
      .from('gateway_transactions')
      .update(updateData)
      .eq('id', transaction.id);

    // 更新 Webhook log
    await supabase
      .from('gateway_webhook_logs')
      .update({ 
        processed: true, 
        process_result: isSuccess ? 'success' : 'failed',
        processed_at: new Date().toISOString()
      })
      .eq('transaction_id', transaction.id)
      .eq('type', 'payment');

    // 付款成功：呼叫 Medusa API 完成訂單
    if (isSuccess && transaction.order_id) {
      try {
        console.log('Raw order_id from DB:', transaction.order_id);

        // 修正重複 prefix 問題：cart_cart_xxx → cart_xxx
        let cartId = transaction.order_id;
        if (cartId.startsWith('cart_cart_')) {
          cartId = cartId.replace('cart_cart_', 'cart_');
          console.log('Fixed duplicate prefix, cartId:', cartId);
        }

        const medusaUrl = merchant.medusa_backend_url || process.env.MEDUSA_BACKEND_URL;
        const medusaKey = merchant.medusa_publishable_key || process.env.MEDUSA_PUBLISHABLE_KEY;

        console.log('Medusa config:', { medusaUrl, hasKey: !!medusaKey, cartId });

        if (medusaUrl && medusaKey && cartId) {
          console.log('Completing Medusa cart:', cartId);

          const medusaResponse = await fetch(`${medusaUrl}/store/carts/${cartId}/complete`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-publishable-api-key': medusaKey
            }
          });

          // Log response status for debugging
          console.log('Medusa response status:', medusaResponse.status);

          const responseText = await medusaResponse.text();
          console.log('Medusa response body:', responseText.substring(0, 500));

          let medusaResult;
          try {
            medusaResult = JSON.parse(responseText);
          } catch (parseErr) {
            console.error('Failed to parse Medusa response as JSON');
            throw new Error(`Non-JSON response from Medusa: ${responseText.substring(0, 200)}`);
          }

          console.log('Medusa complete cart result:', medusaResult);

          if (medusaResult.type === 'order') {
            // 訂單建立成功，記錄 Medusa order_id
            await supabase
              .from('gateway_transactions')
              .update({
                medusa_order_id: medusaResult.order?.id,
                order_completed_at: new Date().toISOString()
              })
              .eq('id', transaction.id);

            console.log('Medusa order created:', medusaResult.order?.id);
          } else {
            console.error('Medusa cart completion failed:', medusaResult.error || medusaResult);
          }
        } else {
          console.log('Medusa integration not configured, skipping cart completion');
        }
      } catch (medusaErr) {
        console.error('Failed to complete Medusa cart:', medusaErr);
        // 不影響 ECPay webhook 回應，繼續處理
      }
    }

    // 通知商家（如果有設定 webhook_url）
    if (merchant.webhook_url) {
      try {
        await fetch(merchant.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'payment.completed',
            transaction_id: transaction.id,
            merchant_trade_no: merchantTradeNo,
            order_id: transaction.order_id,
            status: isSuccess ? 'authorized' : 'failed',
            amount: transaction.amount
          })
        });

        await supabase
          .from('gateway_webhook_logs')
          .update({ merchant_notified: true })
          .eq('transaction_id', transaction.id)
          .eq('type', 'payment');

      } catch (notifyErr) {
        console.error('Failed to notify merchant:', notifyErr);
      }
    }

    // ECPay 要求回傳 1|OK
    res.send('1|OK');

  } catch (err) {
    console.error('Payment webhook error:', err);
    res.send('0|Internal error');
  }
});

/**
 * GET /api/v1/payment/transaction/:id
 * 查詢單筆交易
 */
router.get('/transaction/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: transaction, error } = await supabase
      .from('gateway_transactions')
      .select('id, merchant_trade_no, ecpay_trade_no, amount, currency, status, payment_type, item_name, order_id, created_at, authorized_at, failed_at, error_message')
      .eq('id', id)
      .eq('merchant_id', req.merchant.id)
      .single();

    if (error || !transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.json({ transaction });

  } catch (err) {
    console.error('Get transaction error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/payment/transactions
 * 查詢交易列表
 */
router.get('/transactions', authMiddleware, async (req, res) => {
  try {
    const { status, order_id, limit = 20, offset = 0 } = req.query;

    let query = supabase
      .from('gateway_transactions')
      .select('id, merchant_trade_no, ecpay_trade_no, amount, status, payment_type, item_name, order_id, created_at')
      .eq('merchant_id', req.merchant.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq('status', status);
    }
    if (order_id) {
      query = query.eq('order_id', order_id);
    }

    const { data: transactions, error } = await query;

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch transactions' });
    }

    res.json({ transactions });

  } catch (err) {
    console.error('List transactions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
