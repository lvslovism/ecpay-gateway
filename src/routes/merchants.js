const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { encrypt, generateApiKey } = require('../services/crypto');
const { adminAuthMiddleware } = require('../middleware/auth');

/**
 * POST /api/v1/merchants
 * 建立新商家（需要 Admin API Key）
 */
router.post('/', adminAuthMiddleware, async (req, res) => {
  try {
    const {
      code,
      name,
      ecpay_merchant_id,
      ecpay_hash_key,
      ecpay_hash_iv,
      webhook_url,
      success_url,
      failure_url,
      is_staging = true
    } = req.body;

    // 驗證必填欄位
    if (!code || !name || !ecpay_merchant_id || !ecpay_hash_key || !ecpay_hash_iv || !success_url || !failure_url) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['code', 'name', 'ecpay_merchant_id', 'ecpay_hash_key', 'ecpay_hash_iv', 'success_url', 'failure_url']
      });
    }

    // 檢查 code 是否重複
    const { data: existing } = await supabase
      .from('gateway_merchants')
      .select('id')
      .eq('code', code)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'Merchant code already exists' });
    }

    // 產生 API Key
    const apiKey = generateApiKey();

    // 加密敏感資料
    const encryptedHashKey = encrypt(ecpay_hash_key);
    const encryptedHashIV = encrypt(ecpay_hash_iv);

    // 建立商家
    const { data: merchant, error } = await supabase
      .from('gateway_merchants')
      .insert({
        code,
        name,
        api_key: apiKey,
        ecpay_merchant_id,
        ecpay_hash_key_encrypted: encryptedHashKey,
        ecpay_hash_iv_encrypted: encryptedHashIV,
        webhook_url,
        success_url,
        failure_url,
        is_staging
      })
      .select('id, code, name, api_key, ecpay_merchant_id, is_staging, created_at')
      .single();

    if (error) {
      console.error('Create merchant error:', error);
      return res.status(500).json({ error: 'Failed to create merchant' });
    }

    res.status(201).json({
      success: true,
      merchant,
      message: 'Save the api_key securely, it will not be shown again'
    });

  } catch (err) {
    console.error('Create merchant error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/merchants
 * 列出所有商家（需要 Admin API Key）
 */
router.get('/', adminAuthMiddleware, async (req, res) => {
  try {
    const { data: merchants, error } = await supabase
      .from('gateway_merchants')
      .select('id, code, name, ecpay_merchant_id, is_staging, is_active, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch merchants' });
    }

    res.json({ merchants });

  } catch (err) {
    console.error('List merchants error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
