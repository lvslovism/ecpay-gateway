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

app.listen(PORT, () => {
  console.log(`ECPay Gateway running on port ${PORT}`);
});
