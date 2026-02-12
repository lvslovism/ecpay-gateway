const express = require('express');
const cors = require('cors');

// Routes
const paymentRoutes = require('./routes/payment');
const logisticsRoutes = require('./routes/logistics');
const merchantRoutes = require('./routes/merchants');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // ECPay Webhook 用

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/v1/payment', paymentRoutes);
app.use('/api/v1/logistics', logisticsRoutes);
app.use('/api/v1/merchants', merchantRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`ECPay Gateway running on port ${PORT}`);
});

// ============================================================
// Graceful Shutdown
// Railway redeploy 會發 SIGTERM，如果不處理會直接殺掉正在跑的 webhook
// 加這段後，收到 SIGTERM 會先等進行中的 requests 完成再退出
// ============================================================
let isShuttingDown = false;

process.on('SIGTERM', () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[Shutdown] SIGTERM received, waiting for in-flight requests...');
  
  // 停止接受新連線，等待現有 requests 完成
  server.close(() => {
    console.log('[Shutdown] All requests completed, exiting gracefully');
    process.exit(0);
  });

  // 安全閥：最多等 15 秒，避免永遠卡住
  setTimeout(() => {
    console.warn('[Shutdown] Force exit after 15s timeout');
    process.exit(1);
  }, 15000);
});

process.on('SIGINT', () => {
  console.log('[Shutdown] SIGINT received');
  process.exit(0);
});
