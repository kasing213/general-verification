// OCR Audit Interface JavaScript Application

class AuditApp {
    constructor() {
        this.token = localStorage.getItem('merchant_token');
        this.merchant = JSON.parse(localStorage.getItem('merchant_data') || 'null');
        this.socket = null;
        this.currentPage = 1;
        this.currentFilters = {};
        this.selectedPayment = null;
        this.pendingStatusChange = null;

        this.init();
    }

    init() {
        console.log('🚀 Initializing OCR Audit Interface');

        // Check if user is logged in
        if (!this.token || !this.merchant) {
            this.showLogin();
        } else {
            this.showMainInterface();
            this.connectWebSocket();
            this.loadDashboardData();
        }

        // Set up event listeners
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Filter change events
        document.getElementById('statusFilter').addEventListener('change', () => this.loadPayments());
        document.getElementById('confidenceFilter').addEventListener('change', () => this.loadPayments());
        document.getElementById('bankStatementFilter').addEventListener('change', () => this.loadPayments());
        document.getElementById('dateFromFilter').addEventListener('change', () => this.loadPayments());
        document.getElementById('dateToFilter').addEventListener('change', () => this.loadPayments());

        // Login form
        document.getElementById('loginForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.login();
        });
    }

    showLogin() {
        document.getElementById('mainContainer').style.display = 'none';
        const modal = new bootstrap.Modal(document.getElementById('loginModal'));
        modal.show();
    }

    showMainInterface() {
        document.getElementById('mainContainer').style.display = 'block';
        document.getElementById('merchantName').textContent = this.merchant?.name || 'Merchant';

        // Hide login modal if showing
        const modal = bootstrap.Modal.getInstance(document.getElementById('loginModal'));
        if (modal) modal.hide();
    }

    async login() {
        const merchantId = document.getElementById('merchantId').value;
        const apiKey = document.getElementById('apiKey').value;
        const errorDiv = document.getElementById('loginError');
        const spinner = document.getElementById('loginSpinner');

        if (!merchantId || !apiKey) {
            this.showError(errorDiv, 'Please enter both Merchant ID and API Key');
            return;
        }

        try {
            spinner.style.display = 'inline-block';
            errorDiv.style.display = 'none';

            const response = await fetch('/api/v1/audit/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    merchant_id: merchantId,
                    api_key: apiKey
                }),
                credentials: 'include'
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || 'Login failed');
            }

            // Store credentials
            this.token = data.token;
            this.merchant = data.merchant;
            localStorage.setItem('merchant_token', this.token);
            localStorage.setItem('merchant_data', JSON.stringify(this.merchant));

            console.log('✅ Login successful:', this.merchant.name);

            this.showMainInterface();
            this.connectWebSocket();
            this.loadDashboardData();

        } catch (error) {
            console.error('❌ Login error:', error);
            this.showError(errorDiv, error.message);
        } finally {
            spinner.style.display = 'none';
        }
    }

    logout() {
        console.log('👋 Logging out');

        // Disconnect WebSocket
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }

        // Clear storage
        localStorage.removeItem('merchant_token');
        localStorage.removeItem('merchant_data');
        this.token = null;
        this.merchant = null;

        // Show login
        this.showLogin();

        // Call logout API
        fetch('/api/v1/audit/logout', {
            method: 'POST',
            credentials: 'include'
        });
    }

    connectWebSocket() {
        if (!this.token) return;

        console.log('🔌 Connecting to WebSocket...');
        this.updateConnectionStatus('connecting');

        this.socket = io('/', {
            auth: {
                token: this.token
            }
        });

        this.socket.on('connect', () => {
            console.log('✅ WebSocket connected');
            this.updateConnectionStatus('online');
        });

        this.socket.on('disconnect', (reason) => {
            console.log('❌ WebSocket disconnected:', reason);
            this.updateConnectionStatus('offline');
        });

        this.socket.on('notification', (notification) => {
            console.log('🔔 New notification:', notification);
            this.handleNotification(notification);
        });

        this.socket.on('connected', (data) => {
            console.log('🎉 Welcome message:', data.message);
        });

        this.socket.on('connect_error', (error) => {
            console.error('🔴 WebSocket connection error:', error);
            this.updateConnectionStatus('offline');
        });
    }

    updateConnectionStatus(status) {
        const iconElement = document.getElementById('connectionIcon');
        const textElement = document.getElementById('connectionText');

        iconElement.className = 'bi bi-circle-fill';

        switch (status) {
            case 'online':
                iconElement.classList.add('connection-online');
                textElement.textContent = 'Connected';
                break;
            case 'offline':
                iconElement.classList.add('connection-offline');
                textElement.textContent = 'Disconnected';
                break;
            case 'connecting':
                iconElement.classList.add('connection-connecting');
                textElement.textContent = 'Connecting...';
                break;
        }
    }

    handleNotification(notification) {
        // Update notification badge
        this.updateNotificationBadge();

        // Show browser notification if supported
        if (Notification.permission === 'granted') {
            new Notification(notification.title, {
                body: notification.message,
                icon: '/audit/favicon.ico'
            });
        }

        // If notification is about current payment, refresh details
        if (this.selectedPayment && notification.data?.payment_id === this.selectedPayment._id) {
            this.loadPaymentDetails(this.selectedPayment._id);
        }

        // Refresh payments list if status changed
        if (notification.type === 'payment_status_change') {
            this.loadPayments();
            this.loadDashboardStats();
        }
    }

    async updateNotificationBadge() {
        try {
            const response = await this.apiCall('/api/v1/audit/notifications?limit=1');
            if (response.success) {
                const badge = document.getElementById('notificationBadge');
                if (response.unread_count > 0) {
                    badge.textContent = response.unread_count > 99 ? '99+' : response.unread_count;
                    badge.style.display = 'inline';
                } else {
                    badge.style.display = 'none';
                }
            }
        } catch (error) {
            console.error('Error updating notification badge:', error);
        }
    }

    async loadDashboardData() {
        await this.loadDashboardStats();
        await this.loadPayments();
        await this.updateNotificationBadge();
    }

    async loadDashboardStats() {
        try {
            const response = await this.apiCall('/api/v1/audit/statistics');
            if (response.success) {
                const stats = response.statistics;
                document.getElementById('statsVerified').textContent = stats.verified || 0;
                document.getElementById('statsPending').textContent = stats.pending || 0;
                document.getElementById('statsRejected').textContent = stats.rejected || 0;
                document.getElementById('statsLowConfidence').textContent = stats.low_confidence_count || 0;
            }
        } catch (error) {
            console.error('Error loading dashboard stats:', error);
        }
    }

    async loadPayments(page = 1) {
        try {
            document.getElementById('loadingSpinner').style.display = 'block';
            document.getElementById('paymentsTableContainer').style.display = 'none';

            // Build query parameters
            const params = new URLSearchParams();
            params.append('page', page);
            params.append('limit', '20');

            // Add filters
            const status = document.getElementById('statusFilter').value;
            const confidence = document.getElementById('confidenceFilter').value;
            const bankStatement = document.getElementById('bankStatementFilter').value;
            const dateFrom = document.getElementById('dateFromFilter').value;
            const dateTo = document.getElementById('dateToFilter').value;

            if (status) params.append('status', status);
            if (confidence) params.append('confidence', confidence);
            if (bankStatement) params.append('is_bank_statement', bankStatement);
            if (dateFrom) params.append('date_from', dateFrom);
            if (dateTo) params.append('date_to', dateTo);

            const response = await this.apiCall(`/api/v1/audit/payments?${params.toString()}`);

            if (response.success) {
                this.renderPaymentsTable(response.payments);
                this.renderPagination(response.pagination);
                this.currentPage = page;
            } else {
                throw new Error(response.message || 'Failed to load payments');
            }

        } catch (error) {
            console.error('Error loading payments:', error);
            this.showAlert('danger', 'Failed to load payments: ' + error.message);
        } finally {
            document.getElementById('loadingSpinner').style.display = 'none';
            document.getElementById('paymentsTableContainer').style.display = 'block';
        }
    }

    renderPaymentsTable(payments) {
        const tbody = document.getElementById('paymentsTableBody');
        tbody.innerHTML = '';

        if (payments.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No payments found</td></tr>';
            return;
        }

        payments.forEach(payment => {
            const row = this.createPaymentRow(payment);
            tbody.appendChild(row);
        });
    }

    createPaymentRow(payment) {
        const tr = document.createElement('tr');

        // Format amount
        const amount = payment.amount ?
            payment.amount.toLocaleString('en-US', {
                minimumFractionDigits: payment.currency === 'KHR' ? 0 : 2
            }) : 'N/A';

        // Status badge
        const statusBadge = `<span class="badge status-${payment.verificationStatus}">${payment.verificationStatus}</span>`;

        // Confidence badge
        const confidenceBadge = `<span class="badge confidence-${payment.confidence}">${payment.confidence}</span>`;

        // Date formatting
        const date = payment.uploadedAt ? new Date(payment.uploadedAt).toLocaleDateString() : 'N/A';

        tr.innerHTML = `
            <td>
                <img src="/api/v1/audit/payment/${payment._id}/image"
                     class="payment-screenshot"
                     style="width: 60px; height: 40px; object-fit: cover; cursor: pointer;"
                     onclick="showPaymentDetails('${payment._id}')"
                     onerror="this.src='data:image/svg+xml,<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"60\\" height=\\"40\\"><rect width=\\"100%\\" height=\\"100%\\" fill=\\"%23ddd\\"/><text x=\\"50%\\" y=\\"50%\\" text-anchor=\\"middle\\" dy=\\".3em\\" font-size=\\"12\\">No Image</text></svg>'"
                     alt="Payment Screenshot">
            </td>
            <td>
                <strong>${amount} ${payment.currency || 'KHR'}</strong>
                ${payment.isBankStatement === false ? '<br><small class="text-warning">⚠️ Not bank statement</small>' : ''}
            </td>
            <td>${statusBadge}</td>
            <td>${confidenceBadge}</td>
            <td>${date}</td>
            <td>${payment.bankName || 'N/A'}</td>
            <td>
                <button class="btn btn-sm btn-outline-primary" onclick="showPaymentDetails('${payment._id}')">
                    <i class="bi bi-eye"></i> Details
                </button>
            </td>
        `;

        return tr;
    }

    renderPagination(pagination) {
        const paginationContainer = document.getElementById('pagination');
        const paginationList = document.getElementById('paginationList');

        paginationList.innerHTML = '';

        if (pagination.total_pages <= 1) {
            paginationContainer.style.display = 'none';
            return;
        }

        paginationContainer.style.display = 'block';

        // Previous button
        const prevLi = document.createElement('li');
        prevLi.className = `page-item ${pagination.current_page === 1 ? 'disabled' : ''}`;
        prevLi.innerHTML = `<a class="page-link" href="#" onclick="loadPayments(${pagination.current_page - 1})">Previous</a>`;
        paginationList.appendChild(prevLi);

        // Page numbers
        const startPage = Math.max(1, pagination.current_page - 2);
        const endPage = Math.min(pagination.total_pages, pagination.current_page + 2);

        for (let i = startPage; i <= endPage; i++) {
            const li = document.createElement('li');
            li.className = `page-item ${i === pagination.current_page ? 'active' : ''}`;
            li.innerHTML = `<a class="page-link" href="#" onclick="loadPayments(${i})">${i}</a>`;
            paginationList.appendChild(li);
        }

        // Next button
        const nextLi = document.createElement('li');
        nextLi.className = `page-item ${pagination.current_page === pagination.total_pages ? 'disabled' : ''}`;
        nextLi.innerHTML = `<a class="page-link" href="#" onclick="loadPayments(${pagination.current_page + 1})">Next</a>`;
        paginationList.appendChild(nextLi);
    }

    async showPaymentDetails(paymentId) {
        try {
            const response = await this.apiCall(`/api/v1/audit/payment/${paymentId}`);

            if (!response.success) {
                throw new Error(response.message || 'Failed to load payment details');
            }

            this.selectedPayment = response.payment;
            this.renderPaymentModal(response.payment, response.audit_history, response.available_transitions);

            const modal = new bootstrap.Modal(document.getElementById('paymentModal'));
            modal.show();

            // Subscribe to payment updates via WebSocket
            if (this.socket) {
                this.socket.emit('subscribe_payment', paymentId);
            }

        } catch (error) {
            console.error('Error loading payment details:', error);
            this.showAlert('danger', 'Failed to load payment details: ' + error.message);
        }
    }

    renderPaymentModal(payment, auditHistory, availableTransitions) {
        // Set screenshot
        document.getElementById('paymentScreenshot').src = `/api/v1/audit/payment/${payment._id}/image`;

        // Set payment details
        document.getElementById('detailPaymentId').textContent = payment._id;
        document.getElementById('detailAmount').textContent = payment.amount ?
            payment.amount.toLocaleString('en-US', { minimumFractionDigits: payment.currency === 'KHR' ? 0 : 2 }) : 'N/A';
        document.getElementById('detailCurrency').textContent = payment.currency || 'KHR';
        document.getElementById('detailStatus').innerHTML = `<span class="badge status-${payment.verificationStatus}">${payment.verificationStatus}</span>`;
        document.getElementById('detailConfidence').innerHTML = `<span class="badge confidence-${payment.confidence}">${payment.confidence}</span>`;
        document.getElementById('detailBank').textContent = payment.bankName || 'N/A';
        document.getElementById('detailTransactionId').textContent = payment.transactionId || 'N/A';
        document.getElementById('detailDate').textContent = payment.transactionDate ?
            new Date(payment.transactionDate).toLocaleDateString() : 'N/A';
        document.getElementById('detailRecipient').textContent = payment.recipientName || 'N/A';
        document.getElementById('detailAccount').textContent = payment.toAccount || 'N/A';

        // Render status change buttons
        this.renderStatusButtons(payment.verificationStatus, availableTransitions);

        // Render audit history
        this.renderAuditHistory(auditHistory);
    }

    renderStatusButtons(currentStatus, availableTransitions) {
        const container = document.getElementById('statusButtons');
        container.innerHTML = '';

        const statusConfig = {
            verified: { label: 'Verified', class: 'btn-success', icon: 'check-circle' },
            pending: { label: 'Pending', class: 'btn-warning', icon: 'clock' },
            rejected: { label: 'Rejected', class: 'btn-danger', icon: 'x-circle' }
        };

        availableTransitions.forEach(status => {
            const config = statusConfig[status];
            if (config) {
                const button = document.createElement('button');
                button.className = `btn btn-sm ${config.class} btn-status`;
                button.innerHTML = `<i class="bi bi-${config.icon}"></i> ${config.label}`;
                button.onclick = () => this.initiateStatusChange(status);
                container.appendChild(button);
            }
        });
    }

    initiateStatusChange(newStatus) {
        this.pendingStatusChange = newStatus;

        // Show reason input for rejections or when current confidence is low
        if (newStatus === 'rejected' || this.selectedPayment?.confidence === 'low') {
            document.getElementById('reasonInput').style.display = 'block';
            document.getElementById('statusReason').focus();
        } else {
            // For other status changes, confirm immediately
            this.confirmStatusChange();
        }
    }

    async confirmStatusChange() {
        if (!this.pendingStatusChange || !this.selectedPayment) return;

        const reason = document.getElementById('statusReason').value.trim();

        // Validate reason for rejections
        if (this.pendingStatusChange === 'rejected' && !reason) {
            this.showAlert('warning', 'Reason is required when rejecting payments');
            return;
        }

        try {
            // Disable buttons and show loading
            document.querySelectorAll('.btn-status').forEach(btn => btn.disabled = true);

            const response = await this.apiCall(`/api/v1/audit/payment/${this.selectedPayment._id}/status`, {
                method: 'PATCH',
                body: JSON.stringify({
                    new_status: this.pendingStatusChange,
                    reason: reason || null
                })
            });

            if (response.success) {
                this.showAlert('success', `Payment status updated to ${this.pendingStatusChange}`);

                // Refresh payment details
                await this.showPaymentDetails(this.selectedPayment._id);

                // Refresh payments list and stats
                this.loadPayments(this.currentPage);
                this.loadDashboardStats();
            } else {
                throw new Error(response.message || 'Failed to update status');
            }

        } catch (error) {
            console.error('Error updating payment status:', error);
            this.showAlert('danger', 'Failed to update status: ' + error.message);
        } finally {
            this.cancelStatusChange();
            document.querySelectorAll('.btn-status').forEach(btn => btn.disabled = false);
        }
    }

    cancelStatusChange() {
        this.pendingStatusChange = null;
        document.getElementById('reasonInput').style.display = 'none';
        document.getElementById('statusReason').value = '';
    }

    renderAuditHistory(auditHistory) {
        const container = document.getElementById('auditHistory');
        container.innerHTML = '';

        if (auditHistory.length === 0) {
            container.innerHTML = '<p class="text-muted">No audit history available</p>';
            return;
        }

        auditHistory.forEach(log => {
            const item = document.createElement('div');
            item.className = `timeline-item status-${log.new_status || 'default'}`;

            const time = new Date(log.timestamp).toLocaleString();
            const action = log.action === 'status_change' ?
                `Changed status from ${log.old_status} to ${log.new_status}` :
                log.action;

            item.innerHTML = `
                <div class="timeline-content">
                    <div class="timeline-time">${time}</div>
                    <div><strong>${action}</strong></div>
                    ${log.reason ? `<div class="text-muted">Reason: ${log.reason}</div>` : ''}
                    ${log.notes ? `<div class="text-muted">Notes: ${log.notes}</div>` : ''}
                    <div class="text-muted">By: ${log.merchant_id}</div>
                </div>
            `;

            container.appendChild(item);
        });
    }

    async apiCall(url, options = {}) {
        const defaultOptions = {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.token}`
            },
            credentials: 'include'
        };

        const response = await fetch(url, { ...defaultOptions, ...options });

        if (response.status === 401) {
            // Token expired or invalid
            console.warn('🔒 Authentication failed, redirecting to login');
            this.logout();
            throw new Error('Authentication failed');
        }

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || `HTTP ${response.status}`);
        }

        return data;
    }

    showError(element, message) {
        element.textContent = message;
        element.style.display = 'block';
    }

    showAlert(type, message) {
        // Create alert element
        const alert = document.createElement('div');
        alert.className = `alert alert-${type} alert-dismissible fade show position-fixed`;
        alert.style.top = '80px';
        alert.style.right = '20px';
        alert.style.zIndex = '9999';
        alert.style.minWidth = '300px';

        alert.innerHTML = `
            ${message}
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        `;

        document.body.appendChild(alert);

        // Auto-remove after 5 seconds
        setTimeout(() => {
            if (alert.parentNode) {
                alert.parentNode.removeChild(alert);
            }
        }, 5000);
    }
}

// Global functions for HTML onclick handlers
window.showPaymentDetails = (paymentId) => app.showPaymentDetails(paymentId);
window.loadPayments = (page) => app.loadPayments(page);
window.login = () => app.login();
window.logout = () => app.logout();
window.confirmStatusChange = () => app.confirmStatusChange();
window.cancelStatusChange = () => app.cancelStatusChange();

// Initialize app when DOM is ready
let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new AuditApp();

    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
});