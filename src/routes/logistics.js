const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');

/**
 * 物流 API（Phase 2 實作）
 * 目前先返回 placeholder
 */

router.post('/shipment', authMiddleware, async (req, res) => {
  res.status(501).json({ 
    error: 'Not implemented', 
    message: 'Logistics API will be available in Phase 2' 
  });
});

router.get('/cvs-map', authMiddleware, async (req, res) => {
  res.status(501).json({ 
    error: 'Not implemented', 
    message: 'CVS map will be available in Phase 2' 
  });
});

router.post('/webhook', async (req, res) => {
  res.status(501).json({ 
    error: 'Not implemented', 
    message: 'Logistics webhook will be available in Phase 2' 
  });
});

router.get('/shipment/:id', authMiddleware, async (req, res) => {
  res.status(501).json({ 
    error: 'Not implemented', 
    message: 'Logistics API will be available in Phase 2' 
  });
});

module.exports = router;
