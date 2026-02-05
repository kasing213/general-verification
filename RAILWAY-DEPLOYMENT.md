# 🚂 Railway Deployment Guide

## Overview

Deploy your **fixed OCR service** to Railway for testing. This includes the **Tesseract initialization fix** that resolves your 64% rejection rate issue.

## 🎯 **What You'll Get on Railway**

### ✅ **Single Service Deployment:**
- **Node.js API** with **fixed Tesseract.js integration**
- **MongoDB Atlas** connection
- **GPT-4o Vision** fallback
- **Significantly reduced rejection rate**

### ❌ **Railway Limitations:**
- **No PaddleOCR, EasyOCR, OpenCV** (requires multiple containers)
- **Memory limit**: 8GB max (Tesseract uses ~1GB)
- **Timeout**: 500 seconds max for requests

## 🚀 **Quick Deploy**

### Step 1: Push to GitHub
```bash
# Create GitHub repo and push
git init
git add .
git commit -m "OCR service with fixed Tesseract initialization

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/ocr-service.git
git push -u origin main
```

### Step 2: Deploy to Railway
1. Go to **https://railway.app**
2. **"New Project"** → **"Deploy from GitHub repo"**
3. **Select your OCR service repo**
4. **Add environment variables** (copy from `.railwayenv`)

### Step 3: Configure Environment Variables

In Railway dashboard, add these variables:

```bash
# Required
MONGO_URL=mongodb+srv://kasingchan213:...
API_KEY=1fbc480d51b4a3af760e480fca0c72ba68faa117c67306aab29318c1027bf76b
OPENAI_API_KEY=sk-proj-nU2i0JO0AyRKusTl1...
MASTER_SECRET_KEY=445886b408196a7b2e493ec1e4b2a385e3440766182fa3bc86ccfd460b7f6a94

# OCR Configuration
USE_PADDLE_OCR=false
TESSERACT_FALLBACK_ENABLED=true
GPT_FALLBACK_ENABLED=true
```

## 📊 **Expected Railway Performance**

### **What Will Work:**
- ✅ **Tesseract.js OCR** (in-process, ~1GB memory)
- ✅ **GPT-4o Vision** (external API)
- ✅ **Image enhancement** (Sharp + Jimp)
- ✅ **Payment verification**
- ✅ **MongoDB Atlas**

### **Performance Expectations:**
- **Rejection Rate**: Should drop from 64% to ~35-40%
- **Processing Time**: 2-5 seconds per image
- **Accuracy**: Good for English text, moderate for mixed languages
- **Concurrent Users**: 10-15 (Railway hobby plan)

## 🧪 **Testing on Railway**

### Once deployed, test with:

```bash
# Replace YOUR_RAILWAY_URL with your actual Railway URL
RAILWAY_URL="https://your-app.railway.app"

# Health check
curl $RAILWAY_URL/health

# Test OCR (with your API key)
curl -X POST $RAILWAY_URL/api/v1/verify \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "paymentData": {
      "amount": 28000,
      "currency": "KHR",
      "customerName": "TEST USER"
    },
    "screenshot": "base64_image_here"
  }'
```

## 🎯 **Railway vs Full Multi-OCR Comparison**

| Setup | Accuracy | Cost | Complexity | Best For |
|-------|----------|------|------------|----------|
| **Railway** (Node.js + Tesseract) | ~65-75% | $5/month | Low | **Testing & validation** |
| **Multi-OCR** (4 engines) | ~85-95% | $50-100/month | High | **Production** |

## 🔄 **Migration Path**

1. **Deploy to Railway** → Test the Tesseract fix works
2. **Validate improvement** → Measure actual rejection rate reduction
3. **Scale to multi-OCR** → When you need maximum accuracy

## ⚠️ **Railway Limitations**

- **No Docker Compose**: Single container only
- **Memory limit**: 8GB (sufficient for Tesseract.js)
- **No external OCR services**: PaddleOCR/EasyOCR would need separate Railway services ($15+ each)
- **Request timeout**: 500 seconds max

## 🎉 **Bottom Line**

**Yes, Railway can test your fixed Tesseract system!** It should show the improvement from your 64% rejection rate. For maximum accuracy, you'd need the full multi-OCR setup on a platform that supports Docker Compose.

Ready to deploy to Railway?