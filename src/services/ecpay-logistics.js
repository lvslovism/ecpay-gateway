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
  'FAMI': 'FAMIC2C',      // 全家
  'UNIMART': 'UNIMARTC2C', // 7-11
  'HILIFE': 'HILIFEC2C',   // 萊爾富
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
 * 生成 CheckMacValue (SHA256)
 */
function generateCheckMacValue(params, hashKey, hashIv) {
  // 按照 key 排序
  const sortedKeys = Object.keys(params).sort((a, b) => 
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
  
  // 組合參數字串
  let paramStr = `HashKey=${hashKey}`;
  sortedKeys.forEach(key => {
    paramStr += `&${key}=${params[key]}`;
  });
  paramStr += `&HashIV=${hashIv}`;
  
  // URL encode (大寫)
  paramStr = encodeURIComponent(paramStr).toLowerCase();
  
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
  
  // SHA256 雜湊
  const hash = crypto.createHash('sha256').update(paramStr).digest('hex');
  return hash.toUpperCase();
}

/**
 * 驗證 CheckMacValue
 */
function verifyCheckMacValue(params, hashKey, hashIv) {
  const receivedMac = params.CheckMacValue;
  if (!receivedMac) return false;
  
  // 移除 CheckMacValue 重新計算
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
    IsCollection: data.is_collection ? 'Y' : 'N', // 是否代收貨款
    ServerReplyURL: callbackUrl,
    ExtraData: data.extra_data || ''
  };
  
  // 物流地圖不需要 CheckMacValue
  return { params, tradeNo };
}

/**
 * 生成建立物流單參數
 */
function generateCreateShipmentParams(merchant, data, hashKey, hashIv) {
  const tradeNo = data.merchant_trade_no || generateLogisticsTradeNo();
  
  const params = {
    MerchantID: merchant.ecpay_merchant_id,
    MerchantTradeNo: tradeNo,
    MerchantTradeDate: dayjs().format('YYYY/MM/DD HH:mm:ss'),
    LogisticsType: 'CVS',
    LogisticsSubType: CVS_TYPE_MAP[data.cvs_sub_type] || 'UNIMARTC2C',
    GoodsAmount: data.goods_amount || 1,
    GoodsName: (data.goods_name || '商品').substring(0, 60),
    SenderName: (data.sender_name || '敏捷商店').substring(0, 10),
    SenderPhone: data.sender_phone || '',
    SenderCellPhone: data.sender_cellphone || '0912345678',
    ReceiverName: data.receiver_name.substring(0, 10),
    ReceiverPhone: data.receiver_phone || '',
    ReceiverCellPhone: data.receiver_cellphone || data.receiver_phone,
    ReceiverEmail: data.receiver_email || '',
    ReceiverStoreID: data.receiver_store_id,
    TradeDesc: (data.trade_desc || '網路購物').substring(0, 200),
    ServerReplyURL: data.server_reply_url,
    IsCollection: data.is_collection ? 'Y' : 'N',
    CollectionAmount: data.is_collection ? (data.collection_amount || data.goods_amount) : 0,
    Platform: ''
  };
  
  // 生成 CheckMacValue
  params.CheckMacValue = generateCheckMacValue(params, hashKey, hashIv);
  
  return { params, tradeNo };
}

/**
 * 生成查詢物流狀態參數
 */
function generateQueryParams(merchant, allPayLogisticsId, hashKey, hashIv) {
  const params = {
    MerchantID: merchant.ecpay_merchant_id,
    AllPayLogisticsID: allPayLogisticsId,
    TimeStamp: Math.floor(Date.now() / 1000).toString()
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
    '300': 'created',      // 訂單已建立
    '2030': 'shipping',    // 配送中
    '2063': 'arrived',     // 到店
    '2067': 'picked_up',   // 取貨完成
    '2074': 'returned',    // 退貨
    '9000': 'failed'       // 失敗
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
