const CryptoJS = require('crypto-js');
const dayjs = require('dayjs');

// ECPay API URLs
const ECPAY_URLS = {
  staging: 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5',
  production: 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5'
};

/**
 * 產生 ECPay CheckMacValue
 * @param {Object} params - 所有要簽章的參數
 * @param {string} hashKey - ECPay HashKey
 * @param {string} hashIV - ECPay HashIV
 */
function generateCheckMacValue(params, hashKey, hashIV) {
  // 1. 依照 key 字母排序
  const sortedKeys = Object.keys(params).sort((a, b) => 
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
  
  // 2. 組合成 query string
  let queryString = sortedKeys.map(key => `${key}=${params[key]}`).join('&');
  
  // 3. 前後加上 HashKey 和 HashIV
  queryString = `HashKey=${hashKey}&${queryString}&HashIV=${hashIV}`;
  
  // 4. URL Encode (小寫)
  queryString = encodeURIComponent(queryString).toLowerCase();
  
  // 5. 轉換特殊字元（ECPay 特殊規則）
  queryString = queryString
    .replace(/%2d/g, '-')
    .replace(/%5f/g, '_')
    .replace(/%2e/g, '.')
    .replace(/%21/g, '!')
    .replace(/%2a/g, '*')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .replace(/%20/g, '+');
  
  // 6. SHA256 + 轉大寫
  return CryptoJS.SHA256(queryString).toString(CryptoJS.enc.Hex).toUpperCase();
}

/**
 * 驗證 ECPay 回傳的 CheckMacValue
 */
function verifyCheckMacValue(params, hashKey, hashIV) {
  const receivedMac = params.CheckMacValue;
  const paramsWithoutMac = { ...params };
  delete paramsWithoutMac.CheckMacValue;
  
  const calculatedMac = generateCheckMacValue(paramsWithoutMac, hashKey, hashIV);
  return receivedMac === calculatedMac;
}

/**
 * 建立付款請求參數
 */
function createPaymentParams(options) {
  const {
    merchantId,
    merchantTradeNo,
    merchantTradeDate,
    totalAmount,
    itemName,
    returnUrl,
    clientBackUrl,
    orderResultUrl,
    paymentType = 'aio',
    choosePayment = 'ALL',
    encryptType = 1
  } = options;

  return {
    MerchantID: merchantId,
    MerchantTradeNo: merchantTradeNo,
    MerchantTradeDate: merchantTradeDate || dayjs().format('YYYY/MM/DD HH:mm:ss'),
    PaymentType: paymentType,
    TotalAmount: totalAmount,
    TradeDesc: 'Online Payment',
    ItemName: itemName.substring(0, 200), // 限制 200 字元
    ReturnURL: returnUrl,
    ClientBackURL: clientBackUrl || '',
    OrderResultURL: orderResultUrl || '',
    ChoosePayment: choosePayment,
    EncryptType: encryptType
  };
}

/**
 * 產生付款表單 HTML（自動提交）
 */
function generatePaymentForm(params, checkMacValue, isStaging = true) {
  const actionUrl = isStaging ? ECPAY_URLS.staging : ECPAY_URLS.production;
  
  const inputs = Object.entries(params)
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${value}">`)
    .join('\n');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Redirecting to payment...</title>
</head>
<body>
  <form id="ecpay-form" method="post" action="${actionUrl}">
    ${inputs}
    <input type="hidden" name="CheckMacValue" value="${checkMacValue}">
  </form>
  <script>document.getElementById('ecpay-form').submit();</script>
</body>
</html>
  `.trim();
}

module.exports = {
  generateCheckMacValue,
  verifyCheckMacValue,
  createPaymentParams,
  generatePaymentForm,
  ECPAY_URLS
};
