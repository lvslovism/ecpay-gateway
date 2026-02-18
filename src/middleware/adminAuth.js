/**
 * Admin API Key 認證 Middleware（CMS 管理用）
 * Header: x-admin-api-key
 */
function adminAuth(req, res, next) {
  const apiKey = req.headers['x-admin-api-key'];
  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey) {
    return res.status(500).json({ error: 'Admin API key not configured' });
  }

  if (!apiKey || apiKey !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 記錄來源 IP（Railway 用 x-forwarded-for）
  req.adminIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  next();
}

module.exports = { adminAuth };
