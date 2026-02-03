# OCR Audit Interface

A comprehensive audit interface for merchants to review and update payment verification statuses with real-time notifications and full audit trails.

## Features

### ✅ Status Management
- **Three-state workflow**: `verified` ↔ `pending` ↔ `rejected`
- One-click status updates with confirmation dialogs
- Automatic audit trail logging for all changes
- Reason requirements for rejections and low-confidence payments

### 🔍 Advanced Filtering
- Filter by status (verified, pending, rejected)
- Filter by confidence level (high, medium, low)
- Filter by payment type (bank statements vs other)
- Date range filtering
- Real-time search and pagination

### 📊 Dashboard Analytics
- Live statistics: verified, pending, rejected, low-confidence counts
- Time-based metrics (24h, 7d, 30d)
- Visual status indicators and confidence badges

### 🔔 Real-time Notifications
- WebSocket-based instant updates
- Browser notifications for important events
- Merchant-specific notification channels
- Notification history and read/unread tracking

### 🛡️ Security & Access Control
- JWT-based merchant authentication
- Merchant data isolation
- API rate limiting
- Comprehensive audit logging

### 📱 Responsive Interface
- Bootstrap 5-based UI
- Mobile-friendly design
- Screenshot preview with zoom
- Real-time connection status

## Architecture

### Backend Components

1. **Database Models** (`src/db/mongo.js`)
   - Added `auditLogs` and `notifications` collections
   - Merchant-specific data isolation
   - Comprehensive indexing for performance

2. **Services**
   - `AuditService`: Handles status changes and audit trails
   - `NotificationService`: Manages real-time notifications

3. **Authentication** (`src/middleware/merchant-auth.js`)
   - JWT-based merchant authentication
   - Role-based access control
   - Session management

4. **API Routes** (`src/routes/audit.js`)
   - RESTful audit endpoints
   - Payment management APIs
   - Notification management

5. **WebSocket Server**
   - Real-time bidirectional communication
   - Merchant-specific rooms
   - Payment subscription system

### Frontend Components

1. **Single Page Application** (`public/audit/`)
   - Modern JavaScript ES6+ class-based architecture
   - Bootstrap 5 UI framework
   - Socket.io client for real-time updates

## API Endpoints

### Authentication
- `POST /api/v1/audit/login` - Merchant login
- `POST /api/v1/audit/logout` - Merchant logout
- `GET /api/v1/audit/me` - Get current merchant info

### Payments
- `GET /api/v1/audit/payments` - List payments with filtering
- `GET /api/v1/audit/payment/:id` - Get payment details
- `PATCH /api/v1/audit/payment/:id/status` - Update payment status
- `GET /api/v1/audit/payment/:id/image` - Get payment screenshot
- `GET /api/v1/audit/payment/:id/audit-logs` - Get audit history

### Analytics
- `GET /api/v1/audit/statistics` - Get dashboard statistics

### Notifications
- `GET /api/v1/audit/notifications` - Get notification history
- `PATCH /api/v1/audit/notifications/:id/read` - Mark notification as read
- `POST /api/v1/audit/notifications/mark-all-read` - Mark all as read

### Admin (Advanced)
- `GET /api/v1/audit/admin/payments` - Admin view of all payments
- `GET /api/v1/audit/admin/audit-logs` - Admin view of all audit logs

## Usage

### 1. Start the Server
```bash
npm install
npm start
```

The server will start with:
- HTTP Server: `http://localhost:3000`
- Audit Interface: `http://localhost:3000/audit`
- WebSocket: `ws://localhost:3000`

### 2. Access the Audit Interface
Navigate to `http://localhost:3000/audit` in your browser.

### 3. Login
- **Merchant ID**: Your merchant identifier
- **API Key**: Same as your OCR service API key

### 4. Review Payments
- View dashboard statistics
- Apply filters to find specific payments
- Click "Details" to view payment information
- Click on screenshots to view full-size images

### 5. Update Payment Status
1. Open payment details
2. Click desired status button (Verified/Pending/Rejected)
3. Add reason if required (mandatory for rejections)
4. Confirm the change

### 6. Monitor Real-time Updates
- Connection status shown in bottom-right corner
- Notifications appear in real-time
- Payment list updates automatically

## Environment Variables

Add these to your `.env` file:

```env
# Existing OCR service variables
MONGO_URL=your_mongodb_connection_string
API_KEY=your_api_key

# New audit interface variables
JWT_SECRET=your_jwt_secret_key  # Optional: defaults to API_KEY
JWT_EXPIRES_IN=24h             # Optional: token expiry
FRONTEND_URL=http://localhost:3000  # Optional: for CORS

# Optional notification features
EMAIL_ENABLED=false
SMS_ENABLED=false
```

## Status Workflow

The system implements a three-state workflow:

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  VERIFIED   │◄──►│   PENDING   │◄──►│  REJECTED   │
└─────────────┘    └─────────────┘    └─────────────┘
```

**Valid Transitions:**
- `verified` → `pending` or `rejected`
- `pending` → `verified` or `rejected`
- `rejected` → `verified` or `pending`

**Special Rules:**
- Rejecting low-confidence bank statements requires a reason
- All status changes create audit log entries
- Real-time notifications sent for all changes

## Audit Trail

Every status change is logged with:
- Timestamp of change
- Merchant who made the change
- Old and new status
- Reason (if provided)
- Payment metadata snapshot

## Notifications

### Types
- `payment_status_change`: When payment status is updated
- `low_confidence_alert`: When low-confidence payments need review
- `fraud_alert`: When fraud is detected

### Delivery Methods
- Real-time WebSocket notifications (always enabled)
- Browser notifications (if permission granted)
- Email notifications (if configured)
- SMS notifications (if configured)

## Database Schema

### New Collections

**auditLogs:**
```javascript
{
  id: "unique_audit_id",
  payment_id: "payment_id",
  merchant_id: "merchant_id",
  action: "status_change",
  old_status: "pending",
  new_status: "verified",
  reason: "Payment verified manually",
  timestamp: "2024-01-01T12:00:00.000Z",
  metadata: { /* payment snapshot */ }
}
```

**notifications:**
```javascript
{
  id: "unique_notification_id",
  merchant_id: "merchant_id",
  payment_id: "payment_id",
  type: "payment_status_change",
  title: "Payment Status Updated",
  message: "Payment ABC123 changed from pending to verified",
  data: { /* notification data */ },
  status: "pending", // pending, read
  created_at: "2024-01-01T12:00:00.000Z"
}
```

### Modified Collections

**payments:** Added `merchant_id` field for merchant isolation.

## Security Features

- JWT-based authentication with configurable expiry
- Merchant data isolation (merchants can only see their own data)
- CORS protection with configurable origins
- Rate limiting on status update endpoints
- Immutable audit logs
- Secure cookie handling for sessions

## Troubleshooting

### Connection Issues
- Check WebSocket connection status in bottom-right corner
- Verify JWT token hasn't expired (24h default)
- Check browser console for error messages

### Login Problems
- Ensure API_KEY is correct
- Check merchant_id format
- Verify server is running and accessible

### Notification Issues
- Grant browser notification permissions
- Check WebSocket connection
- Verify merchant_id matches in database

## Development Notes

### Adding New Status Types
1. Update `validStatuses` array in `AuditService`
2. Update `validTransitions` mapping
3. Add CSS classes for new status badges
4. Update frontend status button rendering

### Extending Notifications
1. Add new notification types in `NotificationService`
2. Update frontend notification handlers
3. Add appropriate icons and styling
4. Configure delivery methods

### Custom Merchant Authentication
Replace the simple API key validation in `authenticateMerchant()` with:
- Database-backed merchant validation
- Role-based permissions
- Multi-factor authentication
- OAuth integration

## Production Deployment

1. **Environment Configuration**
   - Set strong `JWT_SECRET`
   - Configure `FRONTEND_URL` for CORS
   - Enable HTTPS for production

2. **Database Optimization**
   - Ensure proper indexing
   - Set up MongoDB replica set
   - Configure connection pooling

3. **Monitoring**
   - Set up application monitoring
   - Configure log aggregation
   - Monitor WebSocket connections

4. **Security**
   - Enable rate limiting
   - Set up reverse proxy (nginx)
   - Configure security headers
   - Regular security updates

The audit interface is now fully functional and ready for merchant use!