const CryptoJS = require('crypto-js');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
  console.error('ENCRYPTION_KEY must be 64 hex characters');
  process.exit(1);
}

/**
 * 加密敏感資料（如 ECPay HashKey/HashIV）
 */
function encrypt(text) {
  const key = CryptoJS.enc.Hex.parse(ENCRYPTION_KEY);
  const iv = CryptoJS.lib.WordArray.random(16);
  const encrypted = CryptoJS.AES.encrypt(text, key, {
    iv: iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7
  });
  // 回傳格式：iv:encrypted (都是 base64)
  return iv.toString(CryptoJS.enc.Base64) + ':' + encrypted.toString();
}

/**
 * 解密敏感資料
 */
function decrypt(encryptedData) {
  const [ivBase64, encrypted] = encryptedData.split(':');
  const key = CryptoJS.enc.Hex.parse(ENCRYPTION_KEY);
  const iv = CryptoJS.enc.Base64.parse(ivBase64);
  const decrypted = CryptoJS.AES.decrypt(encrypted, key, {
    iv: iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7
  });
  return decrypted.toString(CryptoJS.enc.Utf8);
}

/**
 * 產生 API Key
 */
function generateApiKey() {
  return 'gk_' + CryptoJS.lib.WordArray.random(32).toString(CryptoJS.enc.Hex);
}

module.exports = { encrypt, decrypt, generateApiKey };
