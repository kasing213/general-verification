'use strict';

const express = require('express');
const archiver = require('archiver');
const apiKeyAuth = require('../middleware/auth');
const { payments, fraudAlerts, invoices, screenshots } = require('../db/mongo');

const router = express.Router();

/**
 * GET /api/v1/export/payments
 * Export payments as JSON
 */
router.get('/payments', apiKeyAuth, async (req, res) => {
  try {
    const { status, limit = 1000 } = req.query;
    const filter = status ? { verificationStatus: status } : {};
    const data = await payments.findAll ? payments.findAll(filter, { limit: parseInt(limit) }) :
      (await require('../db/mongo').getDb()).collection('payments').find(filter).limit(parseInt(limit)).toArray();
    res.json({ success: true, count: data.length, payments: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/export/invoices
 * Export invoices as JSON
 */
router.get('/invoices', apiKeyAuth, async (req, res) => {
  try {
    const { status, limit = 1000 } = req.query;
    const filter = status ? { status } : {};
    const data = await invoices.list(filter, { limit: parseInt(limit) });
    res.json({ success: true, count: data.length, invoices: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/export/fraud
 * Export fraud alerts as JSON
 */
router.get('/fraud', apiKeyAuth, async (req, res) => {
  try {
    const { status, limit = 1000 } = req.query;
    const filter = status ? { reviewStatus: status } : {};
    const data = await fraudAlerts.list(filter, { limit: parseInt(limit) });
    res.json({ success: true, count: data.length, fraudAlerts: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/export/screenshots
 * Export screenshots as ZIP (organized by verification status)
 */
router.get('/screenshots', apiKeyAuth, async (req, res) => {
  try {
    const status = req.query.status; // Optional: 'verified', 'pending', 'rejected', or 'all'

    const filename = `screenshots_${status || 'all'}_${new Date().toISOString().split('T')[0]}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', { zlib: { level: 5 } });

    archive.on('error', (err) => {
      console.error('Archive error:', err);
      res.status(500).json({ success: false, error: 'Archive failed' });
    });

    archive.pipe(res);

    const statuses = status && status !== 'all'
      ? [status]
      : ['verified', 'pending', 'rejected'];

    // Get screenshots from GridFS
    for (const s of statuses) {
      const gridfsFiles = await screenshots.list({ verificationStatus: s });

      for (const file of gridfsFiles) {
        try {
          const buffer = await screenshots.download(file._id.toString());
          archive.append(buffer, { name: `${s}/${file.filename}` });
        } catch (err) {
          console.error(`Failed to download GridFS file ${file._id}:`, err.message);
        }
      }
      console.log(`Added ${gridfsFiles.length} files from ${s}/`);
    }

    await archive.finalize();
    console.log(`Screenshot export completed: ${filename}`);

  } catch (error) {
    console.error('Screenshot export error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
