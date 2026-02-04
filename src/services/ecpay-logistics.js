/**
 * ECPay 物流服務 - 超商取貨
 * ⚠️ 重要：物流 API 用 MD5，金流 API 用 SHA256
 */
const crypto = require('crypto');
const dayjs = require('dayjs');

// 綠界物流 API 端點
const ECPAY_LOGISTICS_URL = {
  staging: {
    map: 'https://logistics-stage.ecpay.com.tw/Express/map',
    create: 'https://logistics-stage.ecpay.com.tw/Express/Create',
    query: 'https://logistics-stage.ecpay.com.tw/Helper/QueryLogisticsTradeInfo/V4'
  },
  production: {
    map: 'https://logistics.ecpay.com.tw/Express/map',
    create: 'https://logistics.ecpay.com.tw/Express/Create',
    query: 'https://logistics.ecpay.com.tw/Helper/QueryLogisticsTradeInfo/V4'
  }
};

// 超商類型對應
const CVS_TYPE_MAP = {
  'FAMI': 'FAMIC2C',
  'UNIMART': 'UNIMARTC2C',
  'HILIFE': 'HILIFEC2C',
  'FAMIC2C': 'FAMIC2C',
  'UNIMARTC2C': 'UNIMARTC2C',
  'HILIFEC2C': 'HILIFEC2C'
};

/**
 * 生成物流交易編號
 */
function generateLogisticsTradeNo() {
  const date = dayjs().format('YYMMDDHHmmss');
  const random = crypto.randomBytes(4).toString('hex').toUpperCase().substring(0, 6);
  return `${date}${random}`;
}

/**
 * 生成 CheckMacValue
 * ⚠️ 物流用 MD5，金流用 SHA256
 */
function generateCheckMacValue(params, hashKey, hashIv, algorithm = 'md5') {
  // 按照 key 排序（不分大小寫）
  const sortedKeys = Object.keys(params).sort((a, b) => 
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
  
  // 組合參數字串
  let paramStr = `HashKey=${hashKey}`;
  sortedKeys.forEach(key => {
    paramStr += `&${key}=${params[key]}`;
  });
  paramStr += `&HashIV=${hashIv}`;
  
  // Debug log
  console.log('=== CheckMacValue Debug ===');
  console.log('Algorithm:', algorithm);
  console.log('Before encode:', paramStr.substring(0, 200) + '...');
  
  // URL encode
  paramStr = encodeURIComponent(paramStr);
  
  // 轉小寫
  paramStr = paramStr.toLowerCase();
  
  // 綠界特殊字元處理
  paramStr = paramStr
    .replace(/%2d/g, '-')
    .replace(/%5f/g, '_')
    .replace(/%2e/g, '.')
    .replace(/%21/g, '!')
    .replace(/%2a/g, '*')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .replace(/%20/g, '+');
  
  console.log('After encode:', paramStr.substring(0, 200) + '...');
  
  // 雜湊
  const hash = crypto.createHash(algorithm).update(paramStr).digest('hex');
  const result = hash.toUpperCase();
  
  console.log('CheckMacValue:', result);
  console.log('=== End Debug ===');
  
  return result;
}

/**
 * 驗證 CheckMacValue
 */
function verifyCheckMacValue(params, hashKey, hashIv, algorithm = 'md5') {
  const receivedMac = params.CheckMacValue;
  if (!receivedMac) return false;
  
  const paramsWithoutMac = { ...params };
  delete paramsWithoutMac.CheckMacValue;
  
  const calculatedMac = generateCheckMacValue(paramsWithoutMac, hashKey, hashIv, algorithm);
  return calculatedMac === receivedMac;
}

/**
 * 生成超商地圖參數
 */
function generateCvsMapParams(merchant, data, callbackUrl) {
  const tradeNo = generateLogisticsTradeNo();
  
  const params = {
    MerchantID: String(merchant.ecpay_merchant_id),
    MerchantTradeNo: String(tradeNo),
    LogisticsType: 'CVS',
    LogisticsSubType: CVS_TYPE_MAP[data.cvs_type] || 'UNIMARTC2C',
    IsCollection: data.is_collection ? 'Y' : 'N',
    ServerReplyURL: String(callbackUrl),
    ExtraData: String(data.extra_data || '')
  };
  
  return { params, tradeNo };
}

/**
 * 生成建立物流單參數
 * ⚠️ 所有值必須是字串！
 */
function generateCreateShipmentParams(merchant, data, hashKey, hashIv) {
  const tradeNo = data.merchant_trade_no || generateLogisticsTradeNo();
  
  // ⚠️ 重要：ECPay 所有參數必須是字串
  const params = {
    MerchantID: String(merchant.ecpay_merchant_id),
    MerchantTradeNo: String(tradeNo),
    MerchantTradeDate: dayjs().format('YYYY/MM/DD HH:mm:ss'),
    LogisticsType: 'CVS',
    LogisticsSubType: CVS_TYPE_MAP[data.cvs_sub_type] || 'UNIMARTC2C',
    GoodsAmount: String(data.goods_amount || 1),
    GoodsName: String(data.goods_name || '商品').substring(0, 60),
    SenderName: String(data.sender_name || '測試寄件').substring(0, 10),
    SenderCellPhone: String(data.sender_cellphone || '0912345678'),
    ReceiverName: String(data.receiver_name).substring(0, 10),
    ReceiverCellPhone: String(data.receiver_cellphone || data.receiver_phone),
    ReceiverStoreID: String(data.receiver_store_id),
    TradeDesc: String(data.trade_desc || '網路購物').substring(0, 200),
    ServerReplyURL: String(data.server_reply_url || 'https://example.com/webhook'),
    IsCollection: data.is_collection ? 'Y' : 'N',
    CollectionAmount: String(data.is_collection ? (data.collection_amount || data.goods_amount || 0) : 0)
  };
  
  // Debug: 輸出參數
  console.log('=== Shipment Params ===');
  console.log(JSON.stringify(params, null, 2));
  
  // 生成 CheckMacValue（物流用 MD5）
  params.CheckMacValue = generateCheckMacValue(params, hashKey, hashIv, 'md5');
  
  return { params, tradeNo };
}

/**
 * 生成查詢物流狀態參數
 */
function generateQueryParams(merchant, allPayLogisticsId, hashKey, hashIv) {
  const params = {
    MerchantID: String(merchant.ecpay_merchant_id),
    AllPayLogisticsID: String(allPayLogisticsId),
    TimeStamp: String(Math.floor(Date.now() / 1000))
  };
  
  params.CheckMacValue = generateCheckMacValue(params, hashKey, hashIv, 'md5');
  
  return params;
}

/**
 * 取得 API URL
 */
function getApiUrl(type, isStaging = true) {
  const env = isStaging ? 'staging' : 'production';
  return ECPAY_LOGISTICS_URL[env][type];
}

/**
 * 生成超商地圖表單 HTML
 */
function generateMapFormHtml(params, isStaging = true) {
  const url = getApiUrl('map', isStaging);
  
  let formHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>選擇取貨門市</title>
</head>
<body>
  <form id="ecpay-map-form" method="POST" action="${url}">
`;
  
  Object.entries(params).forEach(([key, value]) => {
    formHtml += `    <input type="hidden" name="${key}" value="${value}">\n`;
  });
  
  formHtml += `
  </form>
  <script>document.getElementById('ecpay-map-form').submit();</script>
</body>
</html>`;
  
  return formHtml;
}

/**
 * 解析物流狀態
 */
function parseLogisticsStatus(rtnCode) {
  const statusMap = {
    '300': 'created',
    '2030': 'shipping',
    '2063': 'arrived',
    '2067': 'picked_up',
    '2074': 'returned',
    '9000': 'failed'
  };
  
  return statusMap[rtnCode] || 'pending';
}

module.exports = {
  generateLogisticsTradeNo,
  generateCheckMacValue,
  verifyCheckMacValue,
  generateCvsMapParams,
  generateCreateShipmentParams,
  generateQueryParams,
  getApiUrl,
  generateMapFormHtml,
  parseLogisticsStatus,
  CVS_TYPE_MAP
};
