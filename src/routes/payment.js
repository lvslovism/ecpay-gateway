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
 * 取得 Medusa Admin Token
 * @param {string} medusaUrl - Medusa backend URL
 * @returns {Promise<string|null>} - Admin token or null if failed
 */
async function getMedusaAdminToken(medusaUrl) {
  const email = process.env.MEDUSA_ADMIN_EMAIL;
  const password = process.env.MEDUSA_ADMIN_PASSWORD;

  if (!email || !password) {
    console.log('[Capture] Missing MEDUSA_ADMIN_EMAIL or MEDUSA_ADMIN_PASSWORD');
    return null;
  }

  try {
    const response = await fetch(`${medusaUrl}/auth/user/emailpass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    if (!response.ok) {
      console.error('[Capture] Failed to get admin token:', response.status);
      return null;
    }

    const data = await response.json();
    return data.token || null;
  } catch (err) {
    console.error('[Capture] Error getting admin token:', err.message);
    return null;
  }
}

/**
 * 自動 Capture Payment
 * @param {string} medusaUrl - Medusa backend URL
 * @param {string} orderId - Medusa order ID
 */
async function capturePayment(medusaUrl, orderId) {
  console.log('[Capture] Starting payment capture for order:', orderId);

  // Step 1: Get admin token
  const token = await getMedusaAdminToken(medusaUrl);
  if (!token) {
    console.warn('[Capture] Skipping capture - no admin token');
    return { success: false, reason: 'no_token' };
  }

  try {
    // Step 2: Query order to get payment_id
    console.log('[Capture] Fetching order payment info...');
    const orderResponse = await fetch(
      `${medusaUrl}/admin/orders/${orderId}?fields=+payment_collections.payments.*`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      }
    );

    if (!orderResponse.ok) {
      console.error('[Capture] Failed to fetch order:', orderResponse.status);
      return { success: false, reason: 'fetch_order_failed' };
    }

    const orderData = await orderResponse.json();
    const paymentId = orderData.order?.payment_collections?.[0]?.payments?.[0]?.id;

    if (!paymentId) {
      console.warn('[Capture] No payment found in order');
      return { success: false, reason: 'no_payment_found' };
    }

    console.log('[Capture] Found payment:', paymentId);

    // Step 3: Capture payment
    console.log('[Capture] Capturing payment...');
    const captureResponse = await fetch(
      `${medusaUrl}/admin/payments/${paymentId}/capture`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      }
    );

    if (!captureResponse.ok) {
      const errorText = await captureResponse.text();
      console.error('[Capture] Failed to capture payment:', captureResponse.status, errorText.substring(0, 200));
      return { success: false, reason: 'capture_failed', status: captureResponse.status };
    }

    const captureData = await captureResponse.json();
    console.log('[Capture] Payment captured successfully:', paymentId);
    return { success: true, paymentId, capturedAmount: captureData.payment?.captured_amount };

  } catch (err) {
    console.error('[Capture] Error during capture:', err.message);
    return { success: false, reason: 'exception', error: err.message };
  }
}

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
      cart_id,  // 也接受 cart_id（LIFF checkout 用這個）
      customer_email,
      customer_name,
      customer_phone,
      return_url, // 付款後客戶端跳轉
      metadata = {}
    } = req.body;

    // cart_id 和 order_id 都接受，優先用 order_id（向後相容）
    const effectiveOrderId = order_id || cart_id || null;

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
        order_id: effectiveOrderId,  // 用 effectiveOrderId（支援 cart_id）
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

    // 查詢交易取得 return_url, metadata, order_id
    const { data: transaction, error } = await supabase
      .from('gateway_transactions')
      .select('return_url, order_id, metadata, gateway_merchants(success_url)')
      .eq('merchant_trade_no', merchantTradeNo)
      .single();

    // 決定跳轉目標
    let redirectUrl = transaction?.return_url
      || transaction?.gateway_merchants?.success_url
      || '/';

    // 從 transaction 取 cart_id
    const cartId = transaction?.metadata?.cart_id || transaction?.order_id || '';

    // 組合 query string（只傳必要參數）
    const queryParams = new URLSearchParams({
      MerchantTradeNo: params.MerchantTradeNo || '',
      RtnCode: params.RtnCode || '',
      RtnMsg: params.RtnMsg || '',
      TradeNo: params.TradeNo || '',
      TradeAmt: params.TradeAmt || '',
      PaymentDate: params.PaymentDate || '',
      PaymentType: params.PaymentType || '',
      cart_id: cartId
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

    // ★ 冪等檢查：如果這筆交易已經處理過，直接回 1|OK
    // 防止 ECPay 重送 webhook 時重複 complete cart / capture
    if (['authorized', 'captured', 'completed'].includes(transaction.status)) {
      console.log(`[Webhook] Transaction ${merchantTradeNo} already ${transaction.status}, skipping (idempotent)`);
      await supabase.from('gateway_webhook_logs').insert({
        merchant_id: merchant.id,
        transaction_id: transaction.id,
        type: 'payment',
        source_ip: req.ip,
        raw_body: JSON.stringify(params),
        check_mac_valid: true,
        processed: true,
        process_result: 'skipped_idempotent',
        processed_at: new Date().toISOString()
      });
      return res.send('1|OK');
    }

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
    // 從 order_id 或 metadata.cart_id 取得 cart_id（fallback）
    let cartId = transaction.order_id || transaction.metadata?.cart_id || null;

    if (isSuccess && cartId) {
      try {
        console.log('Raw cart_id:', cartId, '(from order_id:', transaction.order_id, ', metadata.cart_id:', transaction.metadata?.cart_id, ')');

        // 修正重複 prefix 問題：cart_cart_xxx → cart_xxx
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
            const medusaOrderId = medusaResult.order?.id;

            // 訂單建立成功，記錄 Medusa order_id
            await supabase
              .from('gateway_transactions')
              .update({
                medusa_order_id: medusaOrderId,
                order_completed_at: new Date().toISOString()
              })
              .eq('id', transaction.id);

            console.log('Medusa order created:', medusaOrderId);

            // ★ Capture 改為 fire-and-forget（非阻塞）
            // 先讓 webhook 回 1|OK 給 ECPay，capture 在背景執行
            if (medusaOrderId) {
              const txId = transaction.id;
              setImmediate(async () => {
                try {
                  const captureResult = await capturePayment(medusaUrl, medusaOrderId);
                  if (captureResult.success) {
                    console.log('[Capture:bg] Payment captured for order:', medusaOrderId);
                    await supabase
                      .from('gateway_transactions')
                      .update({
                        status: 'captured',
                        captured_at: new Date().toISOString()
                      })
                      .eq('id', txId);
                  } else {
                    console.warn('[Capture:bg] Capture skipped/failed:', captureResult.reason);
                  }
                } catch (captureErr) {
                  console.error('[Capture:bg] Error (will retry on next check):', captureErr.message);
                }
              });

              // ★ 呼叫 order-completed Edge Function（非阻塞，與 capture 平行）
              // 累加消費 + 自動升等
              setImmediate(async () => {
                try {
                  // 從 transaction metadata 取 customer_id
                  let customerId = transaction.metadata?.customer_id;

                  // 如果 metadata 沒有 customer_id，從 Medusa order 查
                  if (!customerId) {
                    try {
                      const adminToken = await getMedusaAdminToken(medusaUrl);
                      if (adminToken) {
                        const orderRes = await fetch(`${medusaUrl}/admin/orders/${medusaOrderId}`, {
                          headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${adminToken}`
                          }
                        });
                        if (orderRes.ok) {
                          const orderData = await orderRes.json();
                          customerId = orderData.order?.customer_id || orderData.order?.customer?.id;
                        }
                      }
                    } catch (e) {
                      console.error('[Tier] Failed to get customer_id from order:', e.message);
                    }
                  }

                  if (customerId) {
                    const supabaseUrl = process.env.SUPABASE_URL;
                    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

                    if (supabaseUrl && supabaseKey) {
                      const response = await fetch(`${supabaseUrl}/functions/v1/order-completed`, {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          'Authorization': `Bearer ${supabaseKey}`,
                          'x-webhook-secret': process.env.ORDER_WEBHOOK_SECRET || ''
                        },
                        body: JSON.stringify({
                          order_id: medusaOrderId,
                          customer_id: customerId,
                          order_total: parseFloat(transaction.amount),
                          source: 'gateway_webhook'
                        })
                      });

                      const result = await response.json();
                      if (result.tier_changed) {
                        console.log(`[Tier] Customer ${customerId} upgraded to ${result.new_tier}`);
                      } else if (result.skipped) {
                        console.log(`[Tier] Order ${medusaOrderId} already processed`);
                      }
                    }
                  } else {
                    console.warn('[Tier] No customer_id available, skipping tier update');
                  }
                } catch (err) {
                  console.error('[Tier] order-completed call failed:', err.message);
                }
              });
            }
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

    // 通知商家（非阻塞，不影響 ECPay 回應）
    if (merchant.webhook_url) {
      const notifyTxId = transaction.id;
      const notifyUrl = merchant.webhook_url;
      setImmediate(async () => {
        try {
          await fetch(notifyUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-webhook-secret': process.env.ORDER_WEBHOOK_SECRET || ''
            },
            body: JSON.stringify({
              event: 'payment.completed',
              transaction_id: notifyTxId,
              merchant_trade_no: merchantTradeNo,
              order_id: transaction.order_id,
              status: isSuccess ? 'authorized' : 'failed',
              amount: transaction.amount
            })
          });

          await supabase
            .from('gateway_webhook_logs')
            .update({ merchant_notified: true })
            .eq('transaction_id', notifyTxId)
            .eq('type', 'payment');

        } catch (notifyErr) {
          console.error('Failed to notify merchant:', notifyErr.message);
        }
      });
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
