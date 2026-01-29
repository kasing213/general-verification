# ML Training Roadmap for OCR Service

Based on 500+ image test results, here's the implementation plan for improving OCR accuracy using machine learning.

## Current Dataset Analysis

### Data Quality (2026-01-24)
- **Total Images:** 500+
- **High Confidence:** 381 images (76%) - Use as training data
- **Medium Confidence:** 15 images (3%) - Use as validation
- **Low Confidence:** 104 images (21%) - Requires manual review

### Bank Distribution
```
ABA Bank Family:    197 images (ABA Bank, ABA BANK, ABA, CT)
ACLEDA Family:      92 images (ACLEDA, ACLEDA Bank, ACLEDA BANK)
Wing Bank:          4 images (Wing, Wing Bank)
Other Banks:        25 images (Vattanac, Canadia, Maybank, Sathapana)
Unknown/Failed:     35 images
```

## Phase 1: Data Preparation (Week 1)

### Task 1.1: Bank Name Standardization
```python
# Create standardized bank mapping
BANK_STANDARDIZATION = {
    'aba_bank': ['ABA Bank', 'ABA BANK', 'ABA', 'CT'],
    'acleda_bank': ['ACLEDA Bank', 'ACLEDA', 'ACLEDA BANK'],
    'wing_bank': ['Wing', 'Wing Bank', 'Wing Bank (Cambodia) Plc'],
    'vattanac_bank': ['Vattanac Bank'],
    'canadia_bank': ['Canadia Bank'],
    'maybank': ['Maybank'],
    'sathapana_bank': ['Sathapana', 'Sathapana Bank']
}
```

### Task 1.2: Create Training Dataset
```bash
node scripts/create-training-dataset.js
```
- Export high-confidence images + labels
- Format for ML training (JSON + image files)
- Split into train/validation/test sets

### Task 1.3: Manual Review Queue
- Queue 104 low-confidence images for manual labeling
- Create web interface for quick labeling
- Expected time: 2-3 hours for 104 images

## Phase 2: Bank-Specific Template Learning (Week 2)

### Task 2.1: ABA Bank Model (197 images)
**Training Focus:**
- CT transfer format recognition
- Amount extraction from "-26,000 KHR" format
- Transaction ID patterns
- Recipient name parsing ("CHAN KASING AND THOEURN THEARY")

**Expected Improvements:**
- Amount accuracy: 85% → 95%
- Name accuracy: 75% → 90%

### Task 2.2: ACLEDA Bank Model (92 images)
**Training Focus:**
- ACLEDA-specific layouts
- Khmer text recognition
- Account number formats
- Success indicator patterns

**Expected Improvements:**
- Bank detection: 90% → 98%
- Field extraction: 80% → 92%

### Task 2.3: Multi-Bank Classifier
```python
# Hierarchical classification approach
Step 1: Is it a bank statement? (Binary classifier)
Step 2: Which bank? (Multi-class classifier)
Step 3: Extract fields (Bank-specific models)
```

## Phase 3: Fine-Tuning GPT-4o Vision (Week 3)

### Task 3.1: Custom Prompt Engineering
```python
# Bank-specific prompts based on learned patterns
ABA_PROMPT = """
You are analyzing an ABA Bank Cambodia transfer confirmation.
Key indicators:
- CT logo with minus amount (-28,000 KHR)
- "Trx. ID:" followed by transaction number
- "To account:" with recipient name in ALL CAPS
- Format: "CHAN KASING AND THOEURN THEARY"
...
"""

ACLEDA_PROMPT = """
You are analyzing an ACLEDA Bank transfer confirmation.
Key indicators:
- "រួចរាល់" (completed) status
- Account format: XXX-XXX-XXX-X-XX
- Green checkmark confirmation
...
"""
```

### Task 3.2: Context-Aware Processing
```python
def analyze_with_context(image_buffer, detected_bank):
    if detected_bank == 'aba_bank':
        return gpt4_vision(image_buffer, ABA_PROMPT)
    elif detected_bank == 'acleda_bank':
        return gpt4_vision(image_buffer, ACLEDA_PROMPT)
    else:
        return gpt4_vision(image_buffer, GENERIC_PROMPT)
```

## Phase 4: Pattern Learning Integration (Week 4)

### Task 4.1: Update Pattern Learning Service
Enhance `app/services/pattern_learning_service.py`:

```python
class EnhancedPatternLearning:
    def learn_from_ml_predictions(self, image_id, ml_result, manual_verification):
        # Learn from both ML predictions and manual corrections

    def get_confidence_boost(self, extracted_data, historical_patterns):
        # Boost confidence based on historical success patterns

    def suggest_manual_review(self, prediction_confidence, similarity_to_known_patterns):
        # Smart queuing for manual review
```

### Task 4.2: Bank Format Recognizer Enhancement
Update `app/services/bank_format_recognizer.py`:

```python
class MLEnhancedBankRecognizer:
    def __init__(self):
        self.ml_models = load_trained_models()

    def recognize_with_ml(self, image_buffer):
        # First pass: ML-based bank detection
        bank_prediction = self.ml_models['bank_classifier'].predict(image_buffer)

        # Second pass: Template matching with ML confidence
        template_result = self.traditional_template_matching(image_buffer, bank_prediction.bank)

        # Combine predictions
        return self.ensemble_predictions([bank_prediction, template_result])
```

## Phase 5: Active Learning Pipeline (Week 5)

### Task 5.1: Continuous Learning System
```python
class ActiveLearningPipeline:
    def process_new_image(self, image_buffer, expected_payment=None):
        # Get ML prediction
        prediction = self.ml_model.predict(image_buffer)

        # Queue for manual review if uncertain
        if prediction.confidence < 0.8:
            self.queue_for_review(image_buffer, prediction)

        # Learn from manual corrections
        if manual_correction_available:
            self.retrain_with_correction(image_buffer, manual_correction)

    def retrain_weekly(self):
        # Retrain models weekly with new verified data
        new_training_data = self.get_verified_corrections_this_week()
        self.update_models(new_training_data)
```

### Task 5.2: Feedback Loop Integration
```python
# In verification pipeline
async def verify_with_ml_feedback(image_buffer, expected_payment):
    ml_result = await ml_enhanced_ocr(image_buffer)

    # Use ML confidence to adjust verification thresholds
    if ml_result.confidence > 0.9:
        verification_threshold = 0.85  # More lenient
    else:
        verification_threshold = 0.95  # More strict

    return enhanced_verification(ml_result, expected_payment, verification_threshold)
```

## Expected Results Timeline

### Week 1 Results:
- Bank name standardization: +15% accuracy
- Clean training dataset ready
- Manual review queue processed

### Week 2 Results:
- ABA Bank accuracy: 85% → 95%
- ACLEDA Bank accuracy: 80% → 92%
- Specialized models deployed

### Week 3 Results:
- Overall OCR accuracy: +20-25%
- Context-aware processing live
- Reduced "Unknown" classifications by 60%

### Week 4 Results:
- Pattern learning enhanced
- Smart confidence scoring
- Automatic review queuing

### Week 5 Results:
- Active learning pipeline live
- Self-improving system
- Weekly model updates

## Success Metrics

### Current Baseline (Estimated):
- Bank Detection: ~85%
- Amount Extraction: ~80%
- Name Recognition: ~75%
- Processing Time: ~2-3 seconds

### Target After ML Training:
- Bank Detection: **95%** (+10%)
- Amount Extraction: **92%** (+12%)
- Name Recognition: **88%** (+13%)
- Processing Time: **1.5 seconds** (-25%)

### Business Impact:
- **Reduced manual review:** 104 → ~20 images
- **Faster verification:** 2-3s → 1.5s
- **Higher confidence:** 76% → 90% high-confidence predictions
- **Better customer experience:** Less "send clearer image" requests

## Implementation Priority

**Immediate (This Week):**
1. Bank name standardization script
2. Manual review of 104 low-confidence images
3. Training dataset export

**High Priority (Weeks 2-3):**
1. ABA Bank specialized model (highest volume)
2. ACLEDA Bank specialized model
3. Context-aware prompting

**Medium Priority (Weeks 4-5):**
1. Pattern learning integration
2. Active learning pipeline
3. Performance monitoring

## Technical Requirements

### Infrastructure:
- **Storage:** 2-3 GB for training images + models
- **Compute:** GPU recommended for model training (optional)
- **Database:** Additional ML metrics tables

### Dependencies:
```json
{
  "scikit-learn": "^1.3.0",      // For traditional ML models
  "tensorflow": "^2.13.0",       // For deep learning (optional)
  "opencv-python": "^4.8.0",     // For image preprocessing
  "pandas": "^2.0.0",            // For data analysis
  "matplotlib": "^3.7.0"         // For visualization
}
```

### Cost Estimate:
- **OpenAI API:** ~$50-100 for training dataset processing
- **Storage:** ~$5/month for model storage
- **Compute:** $0 (using existing infrastructure)

**Total Monthly Cost:** ~$10-15 (95% cost is OpenAI API)

## Risk Mitigation

### Technical Risks:
1. **Overfitting to current dataset**
   - *Solution:* Regular validation with new images

2. **Bank format changes**
   - *Solution:* Active learning detects format changes

3. **Performance degradation**
   - *Solution:* A/B testing before deployment

### Business Risks:
1. **Training time investment**
   - *Solution:* Incremental deployment, immediate wins first

2. **API cost increase**
   - *Solution:* Optimize prompts, cache results

3. **Maintenance overhead**
   - *Solution:* Automated monitoring and alerts

## Conclusion

With 500+ labeled images, you have excellent foundation data for ML training. The phased approach ensures immediate wins while building toward a self-improving system.

**Key Success Factor:** Start with bank name standardization (Week 1) for immediate +15% accuracy boost, then build specialized models for your highest-volume banks (ABA, ACLEDA).

**ROI Timeline:** Break-even after 2-3 weeks, significant improvements visible within 1 month.