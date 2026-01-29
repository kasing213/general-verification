#!/usr/bin/env node
'use strict';

/**
 * OCR Accuracy Testing Script
 *
 * Tests all 600+ images stored in MongoDB GridFS against the OCR engine
 * Generates accuracy reports and confidence analysis
 */

require('dotenv').config();
const { connect, disconnect, screenshots, payments, getDb } = require('../src/db/mongo');
const { analyzePaymentScreenshot } = require('../src/core/ocr-engine');
const { verifyPayment } = require('../src/core/verification');
const fs = require('fs').promises;
const path = require('path');

// Test configuration
const TEST_CONFIG = {
  MAX_IMAGES: parseInt(process.env.TEST_MAX_IMAGES) || 50, // Start with 50, then scale up
  OUTPUT_DIR: './test-results',
  BATCH_SIZE: 10, // Process 10 images at a time
  DELAY_MS: 2000, // 2 second delay between batches to respect rate limits
  SKIP_EXISTING: true, // Skip already tested images
  CONFIDENCE_THRESHOLDS: {
    HIGH: 0.9,
    MEDIUM: 0.7,
    LOW: 0.5
  }
};

// Results tracking
let testResults = {
  totalTested: 0,
  skipped: 0,
  bankStatementDetection: {
    correct: 0,
    incorrect: 0,
    accuracy: 0
  },
  paymentVerification: {
    verified: 0,
    pending: 0,
    rejected: 0
  },
  confidenceDistribution: {
    high: 0,
    medium: 0,
    low: 0
  },
  bankBreakdown: {},
  errors: [],
  averageProcessingTime: 0,
  detailedResults: []
};

/**
 * Initialize test environment
 */
async function initializeTest() {
  console.log('🚀 Starting OCR Accuracy Test Suite');
  console.log(`📊 Configuration: Testing max ${TEST_CONFIG.MAX_IMAGES} images`);

  // Create output directory
  await fs.mkdir(TEST_CONFIG.OUTPUT_DIR, { recursive: true });

  // Connect to MongoDB
  await connect();
  console.log('✅ Connected to MongoDB');

  return true;
}

/**
 * Get test images from GridFS
 */
async function getTestImages() {
  console.log('🔍 Fetching screenshots from GridFS...');

  // Get all payment records with their screenshot references
  const db = getDb();
  const paymentsCollection = db.collection('payments');

  const paymentRecords = await paymentsCollection
    .find({
      screenshotFileId: { $exists: true },
      verificationStatus: { $exists: true } // Only images that have been manually verified
    })
    .sort({ uploadedAt: -1 })
    .limit(TEST_CONFIG.MAX_IMAGES)
    .toArray();

  console.log(`📁 Found ${paymentRecords.length} payment records with screenshots`);

  // Also get standalone screenshots without payment records (for general OCR testing)
  const standaloneImages = await screenshots.list({}, {
    limit: Math.max(0, TEST_CONFIG.MAX_IMAGES - paymentRecords.length)
  });

  console.log(`📸 Found ${standaloneImages.length} standalone screenshots`);

  return {
    paymentsWithScreenshots: paymentRecords,
    standaloneImages: standaloneImages
  };
}

/**
 * Test a single image with known payment data
 */
async function testImageWithExpectedData(paymentRecord) {
  const startTime = Date.now();

  try {
    // Download image from GridFS
    const imageBuffer = await screenshots.download(paymentRecord.screenshotFileId);

    // Extract expected payment data from the record
    const expectedPayment = {
      amount: paymentRecord.amount,
      currency: paymentRecord.currency || 'KHR',
      toAccount: paymentRecord.expectedRecipient?.account,
      recipientNames: paymentRecord.expectedRecipient?.names ? [paymentRecord.expectedRecipient.names] : [],
      bank: paymentRecord.expectedBank,
      tolerancePercent: 5
    };

    console.log(`🧪 Testing image: ${paymentRecord._id} | Expected: ${expectedPayment.amount} ${expectedPayment.currency}`);

    // Run OCR analysis
    const ocrResult = await analyzePaymentScreenshot(imageBuffer);

    // Run full verification pipeline
    const verificationResult = await verifyPayment(imageBuffer, expectedPayment, {
      invoiceId: paymentRecord.invoice_id,
      customerId: paymentRecord.customer_id
    });

    const processingTime = Date.now() - startTime;

    // Compare with known verification status
    const actualStatus = paymentRecord.verificationStatus; // 'verified', 'pending', 'rejected'
    const predictedStatus = verificationResult.verification.status;

    const testResult = {
      paymentId: paymentRecord._id.toString(),
      imageId: paymentRecord.screenshotFileId,
      expected: {
        amount: expectedPayment.amount,
        currency: expectedPayment.currency,
        verificationStatus: actualStatus,
        bank: expectedPayment.bank
      },
      actual: {
        amount: ocrResult.amount,
        currency: ocrResult.currency,
        verificationStatus: predictedStatus,
        bank: ocrResult.bankName,
        confidence: ocrResult.confidence,
        isBankStatement: ocrResult.isBankStatement,
        isPaid: ocrResult.isPaid
      },
      accuracy: {
        bankDetection: ocrResult.isBankStatement === true, // Assume all test images are bank statements
        amountMatch: Math.abs((ocrResult.amount || 0) - expectedPayment.amount) <= (expectedPayment.amount * 0.05),
        statusMatch: predictedStatus === actualStatus,
        bankMatch: !expectedPayment.bank || (ocrResult.bankName && ocrResult.bankName.toLowerCase().includes(expectedPayment.bank.toLowerCase()))
      },
      processingTime,
      timestamp: new Date().toISOString(),
      rawOcrResult: ocrResult,
      verificationResult: verificationResult
    };

    // Update global results
    updateTestResults(testResult);

    return testResult;

  } catch (error) {
    console.error(`❌ Error testing image ${paymentRecord._id}:`, error.message);
    testResults.errors.push({
      paymentId: paymentRecord._id.toString(),
      error: error.message,
      timestamp: new Date().toISOString()
    });
    return null;
  }
}

/**
 * Test a standalone image (no expected data)
 */
async function testStandaloneImage(imageFile) {
  const startTime = Date.now();

  try {
    // Download image from GridFS
    const imageBuffer = await screenshots.download(imageFile._id.toString());

    console.log(`🔬 Testing standalone image: ${imageFile.filename}`);

    // Run OCR analysis only
    const ocrResult = await analyzePaymentScreenshot(imageBuffer);

    const processingTime = Date.now() - startTime;

    const testResult = {
      imageId: imageFile._id.toString(),
      filename: imageFile.filename,
      uploadDate: imageFile.uploadDate,
      actual: {
        amount: ocrResult.amount,
        currency: ocrResult.currency,
        bank: ocrResult.bankName,
        confidence: ocrResult.confidence,
        isBankStatement: ocrResult.isBankStatement,
        isPaid: ocrResult.isPaid,
        transactionId: ocrResult.transactionId,
        recipientName: ocrResult.recipientName,
        toAccount: ocrResult.toAccount
      },
      processingTime,
      timestamp: new Date().toISOString(),
      rawOcrResult: ocrResult
    };

    // Update confidence distribution
    if (ocrResult.confidence === 'high') testResults.confidenceDistribution.high++;
    else if (ocrResult.confidence === 'medium') testResults.confidenceDistribution.medium++;
    else testResults.confidenceDistribution.low++;

    // Update bank breakdown
    if (ocrResult.bankName) {
      testResults.bankBreakdown[ocrResult.bankName] = (testResults.bankBreakdown[ocrResult.bankName] || 0) + 1;
    }

    testResults.detailedResults.push(testResult);

    return testResult;

  } catch (error) {
    console.error(`❌ Error testing standalone image ${imageFile._id}:`, error.message);
    testResults.errors.push({
      imageId: imageFile._id.toString(),
      error: error.message,
      timestamp: new Date().toISOString()
    });
    return null;
  }
}

/**
 * Update global test results
 */
function updateTestResults(result) {
  testResults.totalTested++;
  testResults.detailedResults.push(result);

  // Bank statement detection accuracy
  if (result.accuracy.bankDetection) {
    testResults.bankStatementDetection.correct++;
  } else {
    testResults.bankStatementDetection.incorrect++;
  }

  // Payment verification status
  if (result.actual.verificationStatus === 'verified') testResults.paymentVerification.verified++;
  else if (result.actual.verificationStatus === 'pending') testResults.paymentVerification.pending++;
  else testResults.paymentVerification.rejected++;

  // Confidence distribution
  if (result.actual.confidence === 'high') testResults.confidenceDistribution.high++;
  else if (result.actual.confidence === 'medium') testResults.confidenceDistribution.medium++;
  else testResults.confidenceDistribution.low++;

  // Bank breakdown
  if (result.actual.bank) {
    testResults.bankBreakdown[result.actual.bank] = (testResults.bankBreakdown[result.actual.bank] || 0) + 1;
  }

  // Processing time tracking
  const totalTime = testResults.detailedResults.reduce((sum, r) => sum + r.processingTime, 0);
  testResults.averageProcessingTime = Math.round(totalTime / testResults.totalTested);
}

/**
 * Generate accuracy report
 */
async function generateReport() {
  console.log('📊 Generating accuracy report...');

  // Calculate final accuracy metrics
  testResults.bankStatementDetection.accuracy =
    testResults.bankStatementDetection.correct /
    (testResults.bankStatementDetection.correct + testResults.bankStatementDetection.incorrect);

  const accurateVerifications = testResults.detailedResults.filter(r => r.accuracy?.statusMatch).length;
  const verificationAccuracy = accurateVerifications / testResults.totalTested;

  const accurateAmounts = testResults.detailedResults.filter(r => r.accuracy?.amountMatch).length;
  const amountAccuracy = accurateAmounts / testResults.detailedResults.filter(r => r.expected?.amount).length;

  // Create summary report
  const summary = {
    testConfig: TEST_CONFIG,
    timestamp: new Date().toISOString(),
    overview: {
      totalImages: testResults.totalTested,
      errors: testResults.errors.length,
      averageProcessingTime: testResults.averageProcessingTime + 'ms'
    },
    accuracy: {
      bankStatementDetection: (testResults.bankStatementDetection.accuracy * 100).toFixed(1) + '%',
      verificationStatus: (verificationAccuracy * 100).toFixed(1) + '%',
      amountExtraction: (amountAccuracy * 100).toFixed(1) + '%'
    },
    confidenceDistribution: {
      high: ((testResults.confidenceDistribution.high / testResults.totalTested) * 100).toFixed(1) + '%',
      medium: ((testResults.confidenceDistribution.medium / testResults.totalTested) * 100).toFixed(1) + '%',
      low: ((testResults.confidenceDistribution.low / testResults.totalTested) * 100).toFixed(1) + '%'
    },
    bankBreakdown: testResults.bankBreakdown,
    paymentVerification: testResults.paymentVerification
  };

  // Save detailed results
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const detailedFile = path.join(TEST_CONFIG.OUTPUT_DIR, `detailed-results-${timestamp}.json`);
  const summaryFile = path.join(TEST_CONFIG.OUTPUT_DIR, `summary-report-${timestamp}.json`);

  await fs.writeFile(detailedFile, JSON.stringify(testResults, null, 2));
  await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2));

  // Print summary to console
  console.log('\n🎯 OCR ACCURACY TEST RESULTS');
  console.log('═══════════════════════════════');
  console.log(`📊 Total Images Tested: ${summary.overview.totalImages}`);
  console.log(`⏱️  Average Processing: ${summary.overview.averageProcessingTime}`);
  console.log(`❌ Errors: ${summary.overview.errors}`);
  console.log('');
  console.log('🎯 ACCURACY METRICS:');
  console.log(`   Bank Detection: ${summary.accuracy.bankStatementDetection}`);
  console.log(`   Status Prediction: ${summary.accuracy.verificationStatus}`);
  console.log(`   Amount Extraction: ${summary.accuracy.amountExtraction}`);
  console.log('');
  console.log('🔥 CONFIDENCE DISTRIBUTION:');
  console.log(`   High: ${summary.confidenceDistribution.high}`);
  console.log(`   Medium: ${summary.confidenceDistribution.medium}`);
  console.log(`   Low: ${summary.confidenceDistribution.low}`);
  console.log('');
  console.log('🏦 BANK BREAKDOWN:');
  Object.entries(summary.bankBreakdown).forEach(([bank, count]) => {
    console.log(`   ${bank}: ${count} images`);
  });

  console.log(`\n💾 Detailed results saved: ${detailedFile}`);
  console.log(`📄 Summary report saved: ${summaryFile}`);

  return summary;
}

/**
 * Main test runner
 */
async function runTests() {
  try {
    await initializeTest();

    // Get test images
    const { paymentsWithScreenshots, standaloneImages } = await getTestImages();

    console.log(`\n🧪 TESTING PHASE 1: Payment Verification Accuracy`);
    console.log(`Testing ${paymentsWithScreenshots.length} images with known payment data`);

    // Test images with known payment data (for accuracy measurement)
    for (let i = 0; i < paymentsWithScreenshots.length; i += TEST_CONFIG.BATCH_SIZE) {
      const batch = paymentsWithScreenshots.slice(i, i + TEST_CONFIG.BATCH_SIZE);

      console.log(`\n📦 Processing batch ${Math.floor(i / TEST_CONFIG.BATCH_SIZE) + 1}/${Math.ceil(paymentsWithScreenshots.length / TEST_CONFIG.BATCH_SIZE)}`);

      // Process batch
      const batchPromises = batch.map(payment => testImageWithExpectedData(payment));
      await Promise.all(batchPromises);

      // Rate limiting delay
      if (i + TEST_CONFIG.BATCH_SIZE < paymentsWithScreenshots.length) {
        console.log(`⏳ Waiting ${TEST_CONFIG.DELAY_MS}ms to respect rate limits...`);
        await new Promise(resolve => setTimeout(resolve, TEST_CONFIG.DELAY_MS));
      }
    }

    console.log(`\n🔬 TESTING PHASE 2: General OCR Performance`);
    console.log(`Testing ${standaloneImages.length} standalone images`);

    // Test standalone images (for general performance)
    for (let i = 0; i < standaloneImages.length; i += TEST_CONFIG.BATCH_SIZE) {
      const batch = standaloneImages.slice(i, i + TEST_CONFIG.BATCH_SIZE);

      console.log(`\n📦 Processing batch ${Math.floor(i / TEST_CONFIG.BATCH_SIZE) + 1}/${Math.ceil(standaloneImages.length / TEST_CONFIG.BATCH_SIZE)}`);

      // Process batch
      const batchPromises = batch.map(image => testStandaloneImage(image));
      await Promise.all(batchPromises);

      // Rate limiting delay
      if (i + TEST_CONFIG.BATCH_SIZE < standaloneImages.length) {
        console.log(`⏳ Waiting ${TEST_CONFIG.DELAY_MS}ms to respect rate limits...`);
        await new Promise(resolve => setTimeout(resolve, TEST_CONFIG.DELAY_MS));
      }
    }

    // Generate final report
    const summary = await generateReport();

    console.log('\n✅ Testing completed successfully!');

    return summary;

  } catch (error) {
    console.error('💥 Test suite failed:', error);
    throw error;
  } finally {
    await disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

/**
 * CLI interface
 */
if (require.main === module) {
  const args = process.argv.slice(2);

  // Parse command line arguments
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
OCR Accuracy Testing Script

Usage:
  node test-accuracy.js [options]

Options:
  --max-images N    Test up to N images (default: 50)
  --batch-size N    Process N images per batch (default: 10)
  --delay MS        Delay between batches in milliseconds (default: 2000)
  --output DIR      Output directory for results (default: ./test-results)
  --help, -h        Show this help message

Environment Variables:
  TEST_MAX_IMAGES           Maximum images to test
  OPENAI_API_KEY           OpenAI API key (required)
  MONGO_URL                MongoDB connection string (required)

Examples:
  node test-accuracy.js --max-images 100
  node test-accuracy.js --batch-size 5 --delay 3000
  TEST_MAX_IMAGES=200 node test-accuracy.js
`);
    process.exit(0);
  }

  // Parse options
  const maxImagesIndex = args.indexOf('--max-images');
  if (maxImagesIndex !== -1 && args[maxImagesIndex + 1]) {
    TEST_CONFIG.MAX_IMAGES = parseInt(args[maxImagesIndex + 1]);
  }

  const batchSizeIndex = args.indexOf('--batch-size');
  if (batchSizeIndex !== -1 && args[batchSizeIndex + 1]) {
    TEST_CONFIG.BATCH_SIZE = parseInt(args[batchSizeIndex + 1]);
  }

  const delayIndex = args.indexOf('--delay');
  if (delayIndex !== -1 && args[delayIndex + 1]) {
    TEST_CONFIG.DELAY_MS = parseInt(args[delayIndex + 1]);
  }

  const outputIndex = args.indexOf('--output');
  if (outputIndex !== -1 && args[outputIndex + 1]) {
    TEST_CONFIG.OUTPUT_DIR = args[outputIndex + 1];
  }

  // Run tests
  runTests()
    .then(summary => {
      console.log('\n🎉 All tests completed successfully!');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n💥 Test suite failed:', error);
      process.exit(1);
    });
}

module.exports = {
  runTests,
  testImageWithExpectedData,
  testStandaloneImage,
  generateReport
};