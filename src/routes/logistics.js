/**
 * ECPay 物流服務 - 超商取貨
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
 * 生成 CheckMacValue (物流用 MD5)
 */
function generateCheckMacValue(params, hashKey, hashIv) {
  // 按照 key 排序（不分大小寫）
  const sortedKeys = Object.keys(params).sort((a, b) => 
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
  
  // 組合參數字串：HashKey={value}&key1={value1}&key2={value2}&HashIV={value}
  let rawStr = `HashKey=${hashKey}`;
  sortedKeys.forEach(key => {
    rawStr += `&${key}=${params[key]}`;
  });
  rawStr += `&HashIV=${hashIv}`;
  
  // URL encode (使用 .NET 相容的 encode)
  let encodedStr = encodeURIComponent(rawStr);
  
  // 轉小寫
  encodedStr = encodedStr.toLowerCase();
  
  // 綠界特殊字元還原
  encodedStr = encodedStr
    .replace(/%2d/g, '-')
    .replace(/%5f/g, '_')
    .replace(/%2e/g, '.')
    .replace(/%21/g, '!')
    .replace(/%2a/g, '*')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .replace(/%20/g, '+');
  
  // Debug log
  console.log('CheckMac raw string:', rawStr.substring(0, 100) + '...');
  console.log('CheckMac encoded:', encodedStr.substring(0, 100) + '...');
  
  // MD5 雜湊
  const hash = crypto.createHash('md5').update(encodedStr).digest('hex');
  return hash.toUpperCase();
}

/**
 * 驗證 CheckMacValue
 */
function verifyCheckMacValue(params, hashKey, hashIv) {
  const receivedMac = params.CheckMacValue;
  if (!receivedMac) return false;
  
  const paramsWithoutMac = { ...params };
  delete paramsWithoutMac.CheckMacValue;
  
  const calculatedMac = generateCheckMacValue(paramsWithoutMac, hashKey, hashIv);
  return calculatedMac === receivedMac;
}

/**
 * 生成超商地圖參數
 */
function generateCvsMapParams(merchant, data, callbackUrl) {
  const tradeNo = generateLogisticsTradeNo();
  
  const params = {
    MerchantID: merchant.ecpay_merchant_id,
    MerchantTradeNo: tradeNo,
    LogisticsType: 'CVS',
    LogisticsSubType: CVS_TYPE_MAP[data.cvs_type] || 'UNIMARTC2C',
    IsCollection: data.is_collection ? 'Y' : 'N',
    ServerReplyURL: callbackUrl,
    ExtraData: data.extra_data || ''
  };
  
  return { params, tradeNo };
}

/**
 * 生成建立物流單參數 (C2C 超商取貨)
 */
function generateCreateShipmentParams(merchant, data, hashKey, hashIv) {
  const tradeNo = data.merchant_trade_no || generateLogisticsTradeNo();
  const subType = CVS_TYPE_MAP[data.cvs_sub_type] || 'UNIMARTC2C';
  
  // C2C 必要參數（所有值都要是字串）
  const params = {
    MerchantID: String(merchant.ecpay_merchant_id),
    MerchantTradeNo: String(tradeNo),
    MerchantTradeDate: dayjs().format('YYYY/MM/DD HH:mm:ss'),
    LogisticsType: 'CVS',
    LogisticsSubType: subType,
    GoodsName: String(data.goods_name || '商品').substring(0, 60),
    SenderName: String(data.sender_name || '敏捷商店').substring(0, 10),
    SenderCellPhone: String(data.sender_cellphone || '0912345678'),
    ReceiverName: String(data.receiver_name).substring(0, 10),
    ReceiverCellPhone: String(data.receiver_cellphone || data.receiver_phone || ''),
    ReceiverStoreID: String(data.receiver_store_id),
    ServerReplyURL: String(data.server_reply_url || ''),
    IsCollection: data.is_collection ? 'Y' : 'N'
  };
  
  // 若代收貨款
  if (data.is_collection) {
    params.CollectionAmount = String(data.collection_amount || data.goods_amount || 0);
  }
  
  // Debug: 印出參數（隱藏敏感資訊）
  console.log('Shipment params (before CheckMac):', JSON.stringify(params, null, 2));
  console.log('Using HashKey:', hashKey ? hashKey.substring(0, 4) + '***' : 'NULL');
  console.log('Using HashIV:', hashIv ? hashIv.substring(0, 4) + '***' : 'NULL');
  
  // 生成 CheckMacValue
  params.CheckMacValue = generateCheckMacValue(params, hashKey, hashIv);
  
  console.log('Generated CheckMacValue:', params.CheckMacValue);
  
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
  
  params.CheckMacValue = generateCheckMacValue(params, hashKey, hashIv);
  
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