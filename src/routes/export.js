'use strict';

const express = require('express');
const archiver = require('archiver');
const apiKeyAuth = require('../middleware/auth');
const { fraudAlerts, invoices, screenshots } = require('../db/mongo');

const router = express.Router();

/**
 * Build date filter for queries
 * @param {string} from - Start date (YYYY-MM-DD)
 * @param {string} to - End date (YYYY-MM-DD)
 * @param {string} dateField - Field name for date filtering
 * @returns {object} - MongoDB date filter
 */
function buildDateFilter(from, to, dateField = 'uploadedAt') {
  const filter = {};
  if (from || to) {
    filter[dateField] = {};
    if (from) {
      filter[dateField].$gte = new Date(from);
    }
    if (to) {
      // Add 1 day to include the entire end date
      const endDate = new Date(to);
      endDate.setDate(endDate.getDate() + 1);
      filter[dateField].$lt = endDate;
    }
  }
  return filter;
}

/**
 * GET /api/v1/export/payments
 * Export payments as JSON
 * Query params: ?status=verified&from=2026-01-01&to=2026-01-07&limit=1000
 */
router.get('/payments', apiKeyAuth, async (req, res) => {
  try {
    const { status, from, to, limit = 1000 } = req.query;
    const filter = {
      ...(status ? { verificationStatus: status } : {}),
      ...buildDateFilter(from, to, 'uploadedAt')
    };
    const db = require('../db/mongo').getDb();
    const data = await db.collection('payments')
      .find(filter)
      .sort({ uploadedAt: -1 })
      .limit(parseInt(limit))
      .toArray();
    res.json({
      success: true,
      count: data.length,
      filter: { status, from, to },
      payments: data
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/export/invoices
 * Export invoices as JSON
 * Query params: ?status=pending&from=2026-01-01&to=2026-01-07&limit=1000
 */
router.get('/invoices', apiKeyAuth, async (req, res) => {
  try {
    const { status, from, to, limit = 1000 } = req.query;
    const filter = {
      ...(status ? { status } : {}),
      ...buildDateFilter(from, to, 'created_at')
    };
    const data = await invoices.list(filter, { limit: parseInt(limit) });
    res.json({
      success: true,
      count: data.length,
      filter: { status, from, to },
      invoices: data
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/export/fraud
 * Export fraud alerts as JSON
 * Query params: ?status=PENDING&from=2026-01-01&to=2026-01-07&limit=1000
 */
router.get('/fraud', apiKeyAuth, async (req, res) => {
  try {
    const { status, from, to, limit = 1000 } = req.query;
    const filter = {
      ...(status ? { reviewStatus: status } : {}),
      ...buildDateFilter(from, to, 'detectedAt')
    };
    const data = await fraudAlerts.list(filter, { limit: parseInt(limit) });
    res.json({
      success: true,
      count: data.length,
      filter: { status, from, to },
      fraudAlerts: data
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/export/screenshots
 * Export screenshots as ZIP (organized by verification status)
 * Query params: ?status=verified&from=2026-01-01&to=2026-01-07
 */
router.get('/screenshots', apiKeyAuth, async (req, res) => {
  try {
    const { status, from, to } = req.query;

    const dateStr = from && to ? `${from}_to_${to}` : new Date().toISOString().split('T')[0];
    const filename = `screenshots_${status || 'all'}_${dateStr}.zip`;

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

    // Build date filter for GridFS metadata
    const dateFilter = {};
    if (from) {
      dateFilter['metadata.uploadedAt'] = { $gte: new Date(from) };
    }
    if (to) {
      const endDate = new Date(to);
      endDate.setDate(endDate.getDate() + 1);
      dateFilter['metadata.uploadedAt'] = {
        ...dateFilter['metadata.uploadedAt'],
        $lt: endDate
      };
    }

    // Get screenshots from GridFS
    let totalFiles = 0;
    for (const s of statuses) {
      const db = require('../db/mongo').getDb();
      const query = {
        'metadata.verificationStatus': s,
        ...dateFilter
      };

      const gridfsFiles = await db.collection('screenshots.files')
        .find(query)
        .sort({ uploadDate: -1 })
        .toArray();

      for (const file of gridfsFiles) {
        try {
          const buffer = await screenshots.download(file._id.toString());
          archive.append(buffer, { name: `${s}/${file.filename}` });
          totalFiles++;
        } catch (err) {
          console.error(`Failed to download GridFS file ${file._id}:`, err.message);
        }
      }
      console.log(`Added ${gridfsFiles.length} files from ${s}/`);
    }

    await archive.finalize();
    console.log(`Screenshot export completed: ${filename} (${totalFiles} files)`);

  } catch (error) {
    console.error('Screenshot export error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
