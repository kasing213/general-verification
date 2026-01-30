'use strict';

const request = require('supertest');
const express = require('express');

// Mock the dependencies before requiring the route
jest.mock('../src/db/mongo', () => ({
  getDb: jest.fn()
}));

jest.mock('../src/services/pattern-updater', () => ({
  updatePatternModel: jest.fn().mockResolvedValue({ updated: true }),
  generateImprovedPrompts: jest.fn().mockReturnValue({ prompts: ['improved'] })
}));

const { getDb } = require('../src/db/mongo');
const learningRoutes = require('../src/routes/learning');

// Create test app
function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/learning', learningRoutes);
  return app;
}

describe('Learning API Endpoints', () => {
  let app;
  let mockDb;
  let mockCollection;

  beforeEach(() => {
    app = createTestApp();

    // Setup mock collection
    mockCollection = {
      insertOne: jest.fn().mockResolvedValue({ insertedId: 'test-id-123' }),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            toArray: jest.fn().mockResolvedValue([])
          })
        })
      }),
      aggregate: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([])
      }),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 })
    };

    mockDb = {
      collection: jest.fn().mockReturnValue(mockCollection)
    };

    getDb.mockReturnValue(mockDb);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/learning/receive', () => {
    const validPayload = {
      screenshot_data: { base64: 'test-image-data' },
      analysis: {
        status: 'verified',
        training_data: {
          bank: 'ABA',
          extraction_success: {
            amount: true,
            date: true,
            transactionId: true
          },
          confidence_level: 0.95
        },
        reasons: { image_quality: 'good' },
        patterns: { detected: true }
      },
      tenant_id: 'tenant-123'
    };

    it('should reject requests without API key', async () => {
      const res = await request(app)
        .post('/api/v1/learning/receive')
        .send(validPayload);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Missing API key');
    });

    it('should reject requests with invalid API key', async () => {
      const res = await request(app)
        .post('/api/v1/learning/receive')
        .set('X-API-Key', 'wrong-key')
        .send(validPayload);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid API key');
    });

    it('should return 400 when analysis is missing', async () => {
      const res = await request(app)
        .post('/api/v1/learning/receive')
        .set('X-API-Key', 'test-learning-key')
        .send({ screenshot_data: { base64: 'test' } });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Missing required fields');
    });

    it('should return 400 when screenshot_data is missing', async () => {
      const res = await request(app)
        .post('/api/v1/learning/receive')
        .set('X-API-Key', 'test-learning-key')
        .send({ analysis: { status: 'verified' } });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Missing required fields');
    });

    it('should successfully receive learning data', async () => {
      const res = await request(app)
        .post('/api/v1/learning/receive')
        .set('X-API-Key', 'test-learning-key')
        .send(validPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.learning_id).toBe('test-id-123');
      expect(res.body.learned_patterns).toBeDefined();
      expect(res.body.model_updates).toBeDefined();
      expect(res.body.improved_prompts).toBeDefined();
    });

    it('should store learning data in database', async () => {
      await request(app)
        .post('/api/v1/learning/receive')
        .set('X-API-Key', 'test-learning-key')
        .send(validPayload);

      expect(mockDb.collection).toHaveBeenCalledWith('learning_patterns');
      expect(mockCollection.insertOne).toHaveBeenCalled();

      const insertedData = mockCollection.insertOne.mock.calls[0][0];
      expect(insertedData.tenant_id).toBe('tenant-123');
      expect(insertedData.received_at).toBeDefined();
    });

    it('should also accept main API key', async () => {
      const res = await request(app)
        .post('/api/v1/learning/receive')
        .set('X-API-Key', 'test-api-key')
        .send(validPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('POST /api/v1/learning/share', () => {
    const validPayload = {
      verification_result: {
        verification: { status: 'verified' },
        ocr: {
          confidence: 0.92,
          bank: 'ABA'
        }
      },
      confidence_breakdown: {
        amount: 0.95,
        date: 0.88,
        bank_detection: 0.91
      },
      extraction_patterns: {
        success_indicators: ['clear_amount', 'valid_date'],
        failure_indicators: [],
        bank_specific: { format: 'standard' }
      }
    };

    it('should reject requests without API key', async () => {
      const res = await request(app)
        .post('/api/v1/learning/share')
        .send(validPayload);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 when verification_result is missing', async () => {
      const res = await request(app)
        .post('/api/v1/learning/share')
        .set('X-API-Key', 'test-learning-key')
        .send({ confidence_breakdown: {} });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Missing verification_result');
    });

    it('should successfully share OCR insights', async () => {
      const res = await request(app)
        .post('/api/v1/learning/share')
        .set('X-API-Key', 'test-learning-key')
        .send(validPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.sharing_id).toBe('test-id-123');
      expect(res.body.insights_shared).toBeDefined();
      expect(res.body.bank_learnings).toBeDefined();
    });

    it('should store sharing data in correct collection', async () => {
      await request(app)
        .post('/api/v1/learning/share')
        .set('X-API-Key', 'test-learning-key')
        .send(validPayload);

      expect(mockDb.collection).toHaveBeenCalledWith('ocr_sharing_data');
      expect(mockCollection.insertOne).toHaveBeenCalled();

      const insertedData = mockCollection.insertOne.mock.calls[0][0];
      expect(insertedData.verification_status).toBe('verified');
      expect(insertedData.timestamp).toBeDefined();
    });
  });

  describe('GET /api/v1/learning/stats', () => {
    it('should reject requests without API key', async () => {
      const res = await request(app)
        .get('/api/v1/learning/stats');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('should return default stats when no data exists', async () => {
      const res = await request(app)
        .get('/api/v1/learning/stats')
        .set('X-API-Key', 'test-learning-key');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.learning_statistics).toEqual({
        total_patterns_learned: 0,
        verified_learnings: 0,
        pending_learnings: 0,
        rejected_learnings: 0
      });
      expect(res.body.recent_activity).toEqual([]);
      expect(res.body.last_updated).toBeDefined();
    });

    it('should return existing stats from database', async () => {
      const mockStats = {
        total_patterns_learned: 150,
        verified_learnings: 120,
        pending_learnings: 20,
        rejected_learnings: 10,
        updated_at: new Date()
      };

      mockCollection.findOne.mockResolvedValue(mockStats);

      const res = await request(app)
        .get('/api/v1/learning/stats')
        .set('X-API-Key', 'test-learning-key');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.learning_statistics.total_patterns_learned).toBe(150);
    });

    it('should return recent learning activity', async () => {
      const mockActivity = [
        { tenant_id: 'tenant-1', status: 'verified', received_at: new Date() },
        { tenant_id: 'tenant-2', status: 'pending', received_at: new Date() }
      ];

      mockCollection.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            toArray: jest.fn().mockResolvedValue(mockActivity)
          })
        })
      });

      const res = await request(app)
        .get('/api/v1/learning/stats')
        .set('X-API-Key', 'test-learning-key');

      expect(res.status).toBe(200);
      expect(res.body.recent_activity).toHaveLength(2);
    });

    it('should include accuracy improvements', async () => {
      const mockImprovements = [
        { _id: 'verified', count: 100, avg_confidence: 0.92 },
        { _id: 'rejected', count: 15, avg_confidence: 0.45 }
      ];

      mockCollection.aggregate.mockReturnValue({
        toArray: jest.fn().mockResolvedValue(mockImprovements)
      });

      const res = await request(app)
        .get('/api/v1/learning/stats')
        .set('X-API-Key', 'test-learning-key');

      expect(res.status).toBe(200);
      expect(res.body.accuracy_improvements).toBeDefined();
      expect(res.body.accuracy_improvements.period).toBe('30_days');
    });
  });

  describe('Error handling', () => {
    it('should handle database errors on receive endpoint', async () => {
      mockCollection.insertOne.mockRejectedValue(new Error('Database connection failed'));

      const res = await request(app)
        .post('/api/v1/learning/receive')
        .set('X-API-Key', 'test-learning-key')
        .send({
          screenshot_data: { base64: 'test' },
          analysis: { status: 'verified' },
          tenant_id: 'test'
        });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Database connection failed');
    });

    it('should handle database errors on share endpoint', async () => {
      mockCollection.insertOne.mockRejectedValue(new Error('Write operation failed'));

      const res = await request(app)
        .post('/api/v1/learning/share')
        .set('X-API-Key', 'test-learning-key')
        .send({
          verification_result: {
            verification: { status: 'verified' },
            ocr: { confidence: 0.9, bank: 'ABA' }
          }
        });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });

    it('should handle database errors on stats endpoint', async () => {
      mockCollection.findOne.mockRejectedValue(new Error('Query failed'));

      const res = await request(app)
        .get('/api/v1/learning/stats')
        .set('X-API-Key', 'test-learning-key');

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });
  });
});
