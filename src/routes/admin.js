const express = require('express');
const router = express.Router();
const CryptoJS = require('crypto-js');
const supabase = require('../services/supabase');
const { encrypt, decrypt } = require('../services/crypto');
const { generateCheckMacValue } = require('../services/ecpay-payment');
const { adminAuth } = require('../middleware/adminAuth');

// 所有端點都需要 admin 認證
router.use(adminAuth);

// ============================================================
// Helper Functions
// ============================================================

/**
 * 遮罩敏感資料（前4後4，中間 ****）
 */
function maskSecret(value) {
  if (!value) return '(not set)';
  const len = value.length;
  if (len <= 4) return '*'.repeat(len);
  if (len <= 8) return value.slice(0, 2) + '****' + value.slice(-2);
  return value.slice(0, 4) + '****' + value.slice(-4);
}

/**
 * 寫入 audit_log（medusa-store Supabase）
 *
 * audit_log 表結構：
 *   id (uuid, auto), admin_user_id (uuid), merchant_code (varchar),
 *   action (varchar, NOT NULL), target_table (varchar), target_id (varchar),
 *   changes (jsonb), ip_address (varchar), created_at (timestamptz, auto)
 */
async function writeAuditLog(action, merchantCode, changes, ip) {
  try {
    await supabase.from('audit_log').insert({
      admin_user_id: null,  // Gateway API 操作，無 CMS user
      merchant_code: merchantCode,
      action,
      target_table: 'gateway_merchants',
      target_id: merchantCode,
      changes: {
        ...changes,
        source: 'Gateway Admin API',
        source_ip: ip,
        timestamp: new Date().toISOString()
      },
      ip_address: ip
    });
  } catch (err) {
    console.error('[Admin] Failed to write audit log:', err.message);
    // 不影響主流程
  }
}

// ============================================================
// GET /merchants/:code/credentials — 查詢憑證（遮罩顯示）
// ============================================================
router.get('/merchants/:code/credentials', async (req, res) => {
  try {
    const { code } = req.params;

    const { data: merchant, error } = await supabase
      .from('gateway_merchants')
      .select('code, ecpay_merchant_id, ecpay_hash_key_encrypted, ecpay_hash_iv_encrypted, is_staging, updated_at')
      .eq('code', code)
      .single();

    if (error || !merchant) {
      return res.status(404).json({ error: 'Merchant not found' });
    }

    // 解密後遮罩
    let hashKeyMasked = '(not set)';
    let hashKeySet = false;
    if (merchant.ecpay_hash_key_encrypted) {
      try {
        const decrypted = decrypt(merchant.ecpay_hash_key_encrypted);
        hashKeyMasked = maskSecret(decrypted);
        hashKeySet = true;
      } catch (e) {
        hashKeyMasked = '(decrypt error)';
      }
    }

    let hashIvMasked = '(not set)';
    let hashIvSet = false;
    if (merchant.ecpay_hash_iv_encrypted) {
      try {
        const decrypted = decrypt(merchant.ecpay_hash_iv_encrypted);
        hashIvMasked = maskSecret(decrypted);
        hashIvSet = true;
      } catch (e) {
        hashIvMasked = '(decrypt error)';
      }
    }

    res.json({
      success: true,
      credentials: {
        code: merchant.code,
        ecpay_merchant_id: merchant.ecpay_merchant_id,
        hash_key_set: hashKeySet,
        hash_key_masked: hashKeyMasked,
        hash_iv_set: hashIvSet,
        hash_iv_masked: hashIvMasked,
        is_staging: merchant.is_staging,
        environment: merchant.is_staging ? 'staging' : 'production',
        updated_at: merchant.updated_at
      }
    });

  } catch (err) {
    console.error('[Admin] GET credentials error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// PUT /merchants/:code/credentials — 更新憑證
// ============================================================
router.put('/merchants/:code/credentials', async (req, res) => {
  try {
    const { code } = req.params;
    const { ecpay_merchant_id, ecpay_hash_key, ecpay_hash_iv, environment } = req.body;

    // 輸入驗證
    const errors = [];
    if (!ecpay_merchant_id || !/^\d{7,10}$/.test(ecpay_merchant_id)) {
      errors.push('ecpay_merchant_id must be 7-10 digits');
    }
    if (!ecpay_hash_key || ecpay_hash_key.length !== 16) {
      errors.push('ecpay_hash_key must be exactly 16 characters');
    }
    if (!ecpay_hash_iv || ecpay_hash_iv.length !== 16) {
      errors.push('ecpay_hash_iv must be exactly 16 characters');
    }
    if (!environment || !['staging', 'production'].includes(environment)) {
      errors.push('environment must be "staging" or "production"');
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    // 確認 merchant 存在
    const { data: existing, error: findError } = await supabase
      .from('gateway_merchants')
      .select('id')
      .eq('code', code)
      .single();

    if (findError || !existing) {
      return res.status(404).json({ error: 'Merchant not found' });
    }

    // 加密
    const encryptedHashKey = encrypt(ecpay_hash_key);
    const encryptedHashIV = encrypt(ecpay_hash_iv);

    // 更新
    const { error: updateError } = await supabase
      .from('gateway_merchants')
      .update({
        ecpay_merchant_id,
        ecpay_hash_key_encrypted: encryptedHashKey,
        ecpay_hash_iv_encrypted: encryptedHashIV,
        is_staging: environment === 'staging',
        updated_at: new Date().toISOString()
      })
      .eq('code', code);

    if (updateError) {
      console.error('[Admin] Update credentials error:', updateError);
      return res.status(500).json({ error: 'Failed to update credentials' });
    }

    // 寫 audit log（不記錄 hash_key / hash_iv 明文）
    await writeAuditLog('update_payment_credentials', code, {
      merchant_id: ecpay_merchant_id,
      environment
    }, req.adminIp);

    res.json({
      success: true,
      message: 'Credentials updated successfully',
      credentials: {
        ecpay_merchant_id,
        hash_key_masked: maskSecret(ecpay_hash_key),
        hash_iv_masked: maskSecret(ecpay_hash_iv),
        environment
      }
    });

  } catch (err) {
    console.error('[Admin] PUT credentials error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// POST /merchants/:code/switch-env — 環境切換
// ============================================================
router.post('/merchants/:code/switch-env', async (req, res) => {
  try {
    const { code } = req.params;
    const { target_environment, confirm } = req.body;

    if (confirm !== true) {
      return res.status(400).json({ error: 'Confirmation required', message: 'Set confirm: true to proceed' });
    }

    if (!target_environment || !['staging', 'production'].includes(target_environment)) {
      return res.status(400).json({ error: 'target_environment must be "staging" or "production"' });
    }

    // 查詢當前狀態
    const { data: merchant, error: findError } = await supabase
      .from('gateway_merchants')
      .select('code, is_staging')
      .eq('code', code)
      .single();

    if (findError || !merchant) {
      return res.status(404).json({ error: 'Merchant not found' });
    }

    const previousEnv = merchant.is_staging ? 'staging' : 'production';
    const newIsStaging = target_environment === 'staging';

    // 更新
    const { error: updateError } = await supabase
      .from('gateway_merchants')
      .update({
        is_staging: newIsStaging,
        updated_at: new Date().toISOString()
      })
      .eq('code', code);

    if (updateError) {
      console.error('[Admin] Switch env error:', updateError);
      return res.status(500).json({ error: 'Failed to switch environment' });
    }

    // 寫 audit log
    await writeAuditLog('switch_payment_environment', code, {
      from: previousEnv,
      to: target_environment
    }, req.adminIp);

    res.json({
      success: true,
      previous_environment: previousEnv,
      current_environment: target_environment
    });

  } catch (err) {
    console.error('[Admin] Switch env error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// POST /merchants/:code/test-credentials — 測試憑證有效性
// ============================================================
router.post('/merchants/:code/test-credentials', async (req, res) => {
  try {
    const { code } = req.params;

    // 查詢並解密憑證
    const { data: merchant, error: findError } = await supabase
      .from('gateway_merchants')
      .select('ecpay_merchant_id, ecpay_hash_key_encrypted, ecpay_hash_iv_encrypted, is_staging')
      .eq('code', code)
      .single();

    if (findError || !merchant) {
      return res.status(404).json({ error: 'Merchant not found' });
    }

    if (!merchant.ecpay_hash_key_encrypted || !merchant.ecpay_hash_iv_encrypted) {
      return res.json({
        valid: false,
        message: 'Credentials not set'
      });
    }

    let hashKey, hashIV;
    try {
      hashKey = decrypt(merchant.ecpay_hash_key_encrypted);
      hashIV = decrypt(merchant.ecpay_hash_iv_encrypted);
    } catch (e) {
      return res.json({
        valid: false,
        message: 'Failed to decrypt credentials'
      });
    }

    // 構建 ECPay QueryTradeInfo 請求（查一筆不存在的交易）
    const params = {
      MerchantID: merchant.ecpay_merchant_id,
      MerchantTradeNo: 'TEST' + Date.now(),
      TimeStamp: Math.floor(Date.now() / 1000).toString()
    };

    const checkMacValue = generateCheckMacValue(params, hashKey, hashIV);

    // 決定 ECPay 端點
    const ecpayUrl = merchant.is_staging
      ? 'https://payment-stage.ecpay.com.tw/Cashier/QueryTradeInfo/V5'
      : 'https://payment.ecpay.com.tw/Cashier/QueryTradeInfo/V5';

    // 發送請求
    const formBody = new URLSearchParams({
      ...params,
      CheckMacValue: checkMacValue
    }).toString();

    const response = await fetch(ecpayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody
    });

    const responseText = await response.text();

    // 解析回傳
    // ECPay QueryTradeInfo 回傳 key=value&key=value 格式
    if (responseText.includes('CheckMacValue') && responseText.includes('錯誤')) {
      return res.json({
        valid: false,
        message: 'Credentials invalid: CheckMacValue verification failed'
      });
    }

    // 「查無此筆交易」= 憑證有效（能連上 ECPay，只是查不到交易）
    if (responseText.includes('Succeeded') ||
        responseText.includes('查無') ||
        responseText.includes('TradeStatus')) {
      return res.json({
        valid: true,
        message: 'Credentials valid: Successfully connected to ECPay'
      });
    }

    // 其他錯誤
    res.json({
      valid: false,
      message: `ECPay response: ${responseText.substring(0, 200)}`
    });

  } catch (err) {
    console.error('[Admin] Test credentials error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
