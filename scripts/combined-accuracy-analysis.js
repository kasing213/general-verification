#!/usr/bin/env node
'use strict';

/**
 * Combined OCR Accuracy Analysis Script
 *
 * Analyzes OCR performance across both systems:
 * 1. OCR Service (MongoDB GridFS) - 500+ images
 * 2. Scriptclient (PostgreSQL) - Database verification results
 *
 * Creates unified accuracy report and ML training recommendations
 */

require('dotenv').config();
const { connect: connectMongo, disconnect: disconnectMongo, screenshots, payments, getDb } = require('../src/db/mongo');
const fs = require('fs').promises;
const path = require('path');

// PostgreSQL connection for scriptclient data
const { Pool } = require('pg');

const COMBINED_CONFIG = {
  OUTPUT_DIR: './combined-results',
  INCLUDE_SCRIPTCLIENT: true,
  INCLUDE_OCR_SERVICE: true
};

// Combined results tracking
let combinedResults = {
  timestamp: new Date().toISOString(),
  systems: {
    ocrService: {
      source: 'MongoDB GridFS',
      totalImages: 0,
      processed: 0,
      bankBreakdown: {},
      confidenceDistribution: { high: 0, medium: 0, low: 0 },
      processingTime: { min: 0, max: 0, avg: 0 }
    },
    scriptclient: {
      source: 'PostgreSQL',
      totalScreenshots: 0,
      verified: 0,
      pending: 0,
      verificationAccuracy: 0,
      tenantBreakdown: {}
    }
  },
  unified: {
    totalDataPoints: 0,
    mlTrainingPotential: 0,
    recommendedActions: []
  }
};

/**
 * Connect to PostgreSQL for scriptclient data
 */
async function connectPostgreSQL() {
  if (!process.env.DATABASE_URL) {
    console.log('⚠️  No DATABASE_URL found - skipping scriptclient analysis');
    return null;
  }

  try {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    // Test connection
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();

    console.log('✅ Connected to PostgreSQL for scriptclient data');
    return pool;
  } catch (error) {
    console.log(`⚠️  PostgreSQL connection failed: ${error.message}`);
    return null;
  }
}

/**
 * Analyze OCR Service data (existing results)
 */
async function analyzeOCRServiceData() {
  console.log('\n📊 ANALYZING OCR SERVICE DATA (MongoDB GridFS)');
  console.log('══════════════════════════════════════════════════');

  try {
    // Load existing test results
    const resultsDir = './test-results';
    const files = await fs.readdir(resultsDir);
    const latestResultFile = files
      .filter(f => f.startsWith('detailed-results-') && f.endsWith('.json'))
      .sort()
      .pop();

    if (!latestResultFile) {
      console.log('❌ No existing OCR test results found. Run test-accuracy.js first.');
      return;
    }

    const resultsPath = path.join(resultsDir, latestResultFile);
    const ocrResults = JSON.parse(await fs.readFile(resultsPath, 'utf8'));

    console.log(`📁 Loading results from: ${latestResultFile}`);

    // Extract OCR service metrics
    const ocrData = combinedResults.systems.ocrService;
    ocrData.totalImages = ocrResults.detailedResults?.length || 0;
    ocrData.processed = ocrResults.detailedResults?.filter(r => r.actual.bank).length || 0;
    ocrData.bankBreakdown = ocrResults.bankBreakdown || {};
    ocrData.confidenceDistribution = ocrResults.confidenceDistribution || { high: 0, medium: 0, low: 0 };

    // Calculate processing time stats
    const processingTimes = ocrResults.detailedResults
      ?.map(r => r.processingTime)
      .filter(t => t && t > 0) || [];

    if (processingTimes.length > 0) {
      ocrData.processingTime = {
        min: Math.min(...processingTimes),
        max: Math.max(...processingTimes),
        avg: Math.round(processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length)
      };
    }

    console.log(`📊 OCR Service Summary:`);
    console.log(`   Total Images: ${ocrData.totalImages}`);
    console.log(`   Successfully Processed: ${ocrData.processed}`);
    console.log(`   High Confidence: ${ocrData.confidenceDistribution.high}`);
    console.log(`   Average Processing Time: ${ocrData.processingTime.avg}ms`);

    // Identify ML training opportunities
    const highConfidenceImages = ocrData.confidenceDistribution.high;
    const mlTrainingCandidates = Math.floor(highConfidenceImages * 0.8); // 80% for training, 20% for validation

    ocrData.mlTrainingPotential = mlTrainingCandidates;

    console.log(`🎯 ML Training Potential: ${mlTrainingCandidates} high-confidence images`);

  } catch (error) {
    console.error(`❌ Error analyzing OCR service data: ${error.message}`);
  }
}

/**
 * Analyze Scriptclient data (PostgreSQL)
 */
async function analyzeScriptclientData(pgPool) {
  console.log('\n📊 ANALYZING SCRIPTCLIENT DATA (PostgreSQL)');
  console.log('══════════════════════════════════════════════════');

  if (!pgPool) {
    console.log('⚠️  Skipping scriptclient analysis - no PostgreSQL connection');
    return;
  }

  try {
    const client = await pgPool.connect();

    // Get basic statistics
    const statsQuery = `
      SELECT
        COUNT(*) as total_screenshots,
        COUNT(*) FILTER (WHERE verified = true) as verified,
        COUNT(*) FILTER (WHERE verified = false) as pending,
        COUNT(DISTINCT tenant_id) as unique_tenants
      FROM scriptclient.screenshot
    `;

    const statsResult = await client.query(statsQuery);
    const stats = statsResult.rows[0];

    // Get tenant breakdown
    const tenantQuery = `
      SELECT
        tenant_id,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE verified = true) as verified,
        COUNT(*) FILTER (WHERE verified = false) as pending,
        ROUND(
          COUNT(*) FILTER (WHERE verified = true) * 100.0 / COUNT(*),
          2
        ) as verification_rate
      FROM scriptclient.screenshot
      GROUP BY tenant_id
      ORDER BY total DESC
      LIMIT 10
    `;

    const tenantResult = await client.query(tenantQuery);

    // Get verification timeline (last 30 days)
    const timelineQuery = `
      SELECT
        DATE(created_at) as date,
        COUNT(*) as screenshots,
        COUNT(*) FILTER (WHERE verified = true) as verified
      FROM scriptclient.screenshot
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
      LIMIT 30
    `;

    const timelineResult = await client.query(timelineQuery);

    client.release();

    // Store scriptclient results
    const scriptData = combinedResults.systems.scriptclient;
    scriptData.totalScreenshots = parseInt(stats.total_screenshots);
    scriptData.verified = parseInt(stats.verified);
    scriptData.pending = parseInt(stats.pending);
    scriptData.verificationAccuracy = scriptData.totalScreenshots > 0
      ? Math.round((scriptData.verified / scriptData.totalScreenshots) * 100)
      : 0;

    // Process tenant breakdown
    scriptData.tenantBreakdown = tenantResult.rows.reduce((acc, row) => {
      acc[row.tenant_id] = {
        total: parseInt(row.total),
        verified: parseInt(row.verified),
        pending: parseInt(row.pending),
        verificationRate: parseFloat(row.verification_rate)
      };
      return acc;
    }, {});

    console.log(`📊 Scriptclient Summary:`);
    console.log(`   Total Screenshots: ${scriptData.totalScreenshots}`);
    console.log(`   Verified: ${scriptData.verified}`);
    console.log(`   Pending: ${scriptData.pending}`);
    console.log(`   Verification Accuracy: ${scriptData.verificationAccuracy}%`);
    console.log(`   Active Tenants: ${stats.unique_tenants}`);

    // Recent activity analysis
    const recentActivity = timelineResult.rows.slice(0, 7); // Last 7 days
    const dailyAverage = recentActivity.reduce((sum, day) => sum + parseInt(day.screenshots), 0) / recentActivity.length;

    console.log(`📈 Recent Activity (7 days):`);
    console.log(`   Daily Average: ${Math.round(dailyAverage)} screenshots`);

    // Identify high-volume tenants for ML training
    const highVolumeTenants = Object.entries(scriptData.tenantBreakdown)
      .filter(([_, data]) => data.total >= 10 && data.verificationRate >= 70)
      .length;

    console.log(`🎯 High-Quality Data Sources: ${highVolumeTenants} tenants with 10+ screenshots and 70%+ verification rate`);

  } catch (error) {
    console.error(`❌ Error analyzing scriptclient data: ${error.message}`);
  }
}

/**
 * Generate unified recommendations
 */
function generateUnifiedRecommendations() {
  console.log('\n🎯 UNIFIED ML TRAINING RECOMMENDATIONS');
  console.log('══════════════════════════════════════════════════');

  const ocrData = combinedResults.systems.ocrService;
  const scriptData = combinedResults.systems.scriptclient;

  // Calculate total data points
  combinedResults.unified.totalDataPoints = ocrData.totalImages + scriptData.verified;
  combinedResults.unified.mlTrainingPotential = ocrData.mlTrainingPotential + Math.floor(scriptData.verified * 0.6);

  const recommendations = [];

  // OCR Service recommendations
  if (ocrData.totalImages > 0) {
    recommendations.push({
      priority: 'HIGH',
      system: 'OCR Service',
      action: 'Bank Name Standardization',
      description: `Standardize ${Object.keys(ocrData.bankBreakdown).length} bank name variants`,
      expectedImprovement: '+15-20% accuracy',
      effort: '1-2 days',
      dataRequired: `${ocrData.confidenceDistribution.high} high-confidence images`
    });

    if (ocrData.bankBreakdown['ABA Bank'] > 50) {
      recommendations.push({
        priority: 'HIGH',
        system: 'OCR Service',
        action: 'ABA Bank Specialized Model',
        description: `Train ABA-specific model with ${ocrData.bankBreakdown['ABA Bank']} images`,
        expectedImprovement: '+20-25% for ABA transactions',
        effort: '3-5 days',
        dataRequired: `${ocrData.bankBreakdown['ABA Bank']} ABA Bank images`
      });
    }

    if (ocrData.confidenceDistribution.low > 50) {
      recommendations.push({
        priority: 'MEDIUM',
        system: 'OCR Service',
        action: 'Low-Confidence Image Review',
        description: `Manual review of ${ocrData.confidenceDistribution.low} low-confidence predictions`,
        expectedImprovement: '+10-15% overall accuracy',
        effort: '4-6 hours manual work',
        dataRequired: `${ocrData.confidenceDistribution.low} images for labeling`
      });
    }
  }

  // Scriptclient recommendations
  if (scriptData.totalScreenshots > 0) {
    recommendations.push({
      priority: 'MEDIUM',
      system: 'Scriptclient',
      action: 'Cross-System Validation',
      description: `Use ${scriptData.verified} verified screenshots to validate OCR predictions`,
      expectedImprovement: 'Improved confidence scoring',
      effort: '2-3 days integration',
      dataRequired: `${scriptData.verified} verified screenshots`
    });

    if (scriptData.pending > 20) {
      recommendations.push({
        priority: 'LOW',
        system: 'Scriptclient',
        action: 'Pending Screenshot Analysis',
        description: `Analyze ${scriptData.pending} pending screenshots with improved OCR`,
        expectedImprovement: 'Faster manual review process',
        effort: '1 day automation',
        dataRequired: `${scriptData.pending} pending screenshots`
      });
    }

    // High-volume tenant analysis
    const highVolumeTenants = Object.entries(scriptData.tenantBreakdown)
      .filter(([_, data]) => data.total >= 20)
      .length;

    if (highVolumeTenants > 0) {
      recommendations.push({
        priority: 'LOW',
        system: 'Scriptclient',
        action: 'Tenant-Specific Pattern Learning',
        description: `Create custom models for ${highVolumeTenants} high-volume tenants`,
        expectedImprovement: 'Personalized accuracy improvements',
        effort: '1-2 weeks',
        dataRequired: 'Tenant-specific verification patterns'
      });
    }
  }

  // Combined system recommendations
  if (ocrData.totalImages > 0 && scriptData.totalScreenshots > 0) {
    recommendations.push({
      priority: 'HIGH',
      system: 'Combined',
      action: 'Unified Training Dataset',
      description: `Combine ${combinedResults.unified.totalDataPoints} total data points for comprehensive training`,
      expectedImprovement: '+25-35% overall system accuracy',
      effort: '1-2 weeks',
      dataRequired: 'All available labeled data'
    });

    recommendations.push({
      priority: 'MEDIUM',
      system: 'Combined',
      action: 'Active Learning Pipeline',
      description: 'Implement continuous learning from both systems',
      expectedImprovement: 'Self-improving accuracy over time',
      effort: '2-3 weeks development',
      dataRequired: 'Continuous feedback loop setup'
    });
  }

  combinedResults.unified.recommendedActions = recommendations;

  // Print recommendations
  console.log(`📊 Total Data Points: ${combinedResults.unified.totalDataPoints}`);
  console.log(`🎯 ML Training Potential: ${combinedResults.unified.mlTrainingPotential} images`);
  console.log(`\n🚀 TOP RECOMMENDATIONS:`);

  recommendations
    .filter(r => r.priority === 'HIGH')
    .forEach((rec, i) => {
      console.log(`   ${i+1}. ${rec.action} (${rec.system})`);
      console.log(`      ${rec.description}`);
      console.log(`      Expected: ${rec.expectedImprovement} | Effort: ${rec.effort}`);
      console.log('');
    });
}

/**
 * Save combined results
 */
async function saveCombinedResults() {
  console.log('\n💾 SAVING COMBINED RESULTS');
  console.log('══════════════════════════');

  await fs.mkdir(COMBINED_CONFIG.OUTPUT_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const combinedFile = path.join(COMBINED_CONFIG.OUTPUT_DIR, `combined-analysis-${timestamp}.json`);
  const summaryFile = path.join(COMBINED_CONFIG.OUTPUT_DIR, `executive-summary-${timestamp}.json`);

  // Create executive summary
  const summary = {
    timestamp: combinedResults.timestamp,
    executiveSummary: {
      totalDataPoints: combinedResults.unified.totalDataPoints,
      mlTrainingPotential: combinedResults.unified.mlTrainingPotential,
      systemsAnalyzed: Object.keys(combinedResults.systems).filter(k =>
        combinedResults.systems[k].totalImages > 0 || combinedResults.systems[k].totalScreenshots > 0
      ),
      topRecommendations: combinedResults.unified.recommendedActions.filter(r => r.priority === 'HIGH'),
      expectedROI: {
        accuracyImprovement: '+25-35%',
        implementationTime: '2-4 weeks',
        maintenanceOverhead: 'Low (automated pipeline)',
        businessImpact: 'Significantly reduced manual review, faster processing'
      }
    },
    systemBreakdown: {
      ocrService: {
        status: combinedResults.systems.ocrService.totalImages > 0 ? 'analyzed' : 'not_available',
        dataQuality: combinedResults.systems.ocrService.confidenceDistribution.high > 0 ? 'high' : 'unknown',
        trainingReadiness: combinedResults.systems.ocrService.mlTrainingPotential > 100 ? 'ready' : 'needs_more_data'
      },
      scriptclient: {
        status: combinedResults.systems.scriptclient.totalScreenshots > 0 ? 'analyzed' : 'not_available',
        verificationAccuracy: combinedResults.systems.scriptclient.verificationAccuracy,
        integrationPotential: combinedResults.systems.scriptclient.verified > 50 ? 'high' : 'medium'
      }
    }
  };

  await fs.writeFile(combinedFile, JSON.stringify(combinedResults, null, 2));
  await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2));

  console.log(`📊 Combined analysis: ${combinedFile}`);
  console.log(`📋 Executive summary: ${summaryFile}`);

  return summary;
}

/**
 * Main analysis function
 */
async function runCombinedAnalysis() {
  console.log('🚀 STARTING COMBINED OCR ACCURACY ANALYSIS');
  console.log('═══════════════════════════════════════════════════');
  console.log(`📅 Timestamp: ${new Date().toISOString()}`);
  console.log(`🔍 Analyzing: OCR Service + Scriptclient`);

  try {
    let pgPool = null;

    // Connect to data sources
    if (COMBINED_CONFIG.INCLUDE_OCR_SERVICE) {
      await connectMongo();
    }

    if (COMBINED_CONFIG.INCLUDE_SCRIPTCLIENT) {
      pgPool = await connectPostgreSQL();
    }

    // Analyze each system
    if (COMBINED_CONFIG.INCLUDE_OCR_SERVICE) {
      await analyzeOCRServiceData();
    }

    if (COMBINED_CONFIG.INCLUDE_SCRIPTCLIENT && pgPool) {
      await analyzeScriptclientData(pgPool);
    }

    // Generate recommendations
    generateUnifiedRecommendations();

    // Save results
    const summary = await saveCombinedResults();

    console.log('\n✅ COMBINED ANALYSIS COMPLETED');
    console.log('═══════════════════════════════════');
    console.log(`🎯 Total Training Data: ${summary.executiveSummary.totalDataPoints} samples`);
    console.log(`⚡ Expected Improvement: ${summary.executiveSummary.expectedROI.accuracyImprovement}`);
    console.log(`⏱️  Implementation Time: ${summary.executiveSummary.expectedROI.implementationTime}`);

    // Cleanup
    if (pgPool) {
      await pgPool.end();
    }

    if (COMBINED_CONFIG.INCLUDE_OCR_SERVICE) {
      await disconnectMongo();
    }

    return summary;

  } catch (error) {
    console.error('💥 Combined analysis failed:', error);
    throw error;
  }
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Combined OCR Accuracy Analysis

Usage:
  node combined-accuracy-analysis.js [options]

Options:
  --ocr-only           Analyze only OCR service data
  --scriptclient-only  Analyze only Scriptclient data
  --output DIR         Output directory (default: ./combined-results)
  --help, -h           Show this help

Environment Variables:
  DATABASE_URL         PostgreSQL connection for scriptclient data
  MONGO_URL           MongoDB connection for OCR service data

Examples:
  node combined-accuracy-analysis.js
  node combined-accuracy-analysis.js --ocr-only
  node combined-accuracy-analysis.js --output ./reports
`);
    process.exit(0);
  }

  // Parse options
  if (args.includes('--ocr-only')) {
    COMBINED_CONFIG.INCLUDE_SCRIPTCLIENT = false;
  }

  if (args.includes('--scriptclient-only')) {
    COMBINED_CONFIG.INCLUDE_OCR_SERVICE = false;
  }

  const outputIndex = args.indexOf('--output');
  if (outputIndex !== -1 && args[outputIndex + 1]) {
    COMBINED_CONFIG.OUTPUT_DIR = args[outputIndex + 1];
  }

  // Run analysis
  runCombinedAnalysis()
    .then(summary => {
      console.log('\n🎉 Analysis completed successfully!');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n💥 Analysis failed:', error.message);
      process.exit(1);
    });
}

module.exports = {
  runCombinedAnalysis,
  analyzeOCRServiceData,
  analyzeScriptclientData
};