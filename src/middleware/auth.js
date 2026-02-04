const supabase = require('../services/supabase');

/**
 * API Key 認證 Middleware
 * Header: x-api-key: gk_xxx
 */
async function authMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key' });
  }
  
  try {
    const { data: merchant, error } = await supabase
      .from('gateway_merchants')
      .select('*')
      .eq('api_key', apiKey)
      .eq('is_active', true)
      .single();
    
    if (error || !merchant) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    // 附加商家資訊到 request
    req.merchant = merchant;
    next();
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Admin API Key 認證（建立商家用）
 */
function adminAuthMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const adminKey = process.env.ADMIN_API_KEY;
  
  if (!adminKey) {
    return res.status(500).json({ error: 'Admin API key not configured' });
  }
  
  if (apiKey !== adminKey) {
    return res.status(401).json({ error: 'Invalid admin API key' });
  }
  
  next();
}

module.exports = { authMiddleware, adminAuthMiddleware };
