/**
 * Mock Lightning/Voltage integration
 * Replace this with real Voltage API calls when ready
 */

const { v4: uuidv4 } = require('uuid');

// In-memory store for mock invoices (in production, this comes from Voltage/LND)
const mockInvoices = new Map();
const mockPayments = new Map();

/**
 * Generate a mock Lightning invoice for deposits
 * In production: Call Voltage API to create real invoice
 */
function createInvoice(amountSats, memo = 'Deposit to Bitcoin Chess 960 Predictions') {
  const paymentHash = uuidv4().replace(/-/g, '');
  const invoice = {
    payment_hash: paymentHash,
    payment_request: `lnbc${amountSats}n1mock${paymentHash.slice(0, 20)}`, // Fake invoice string
    amount_sats: amountSats,
    memo,
    status: 'pending',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600000).toISOString(), // 1 hour expiry
  };
  
  mockInvoices.set(paymentHash, invoice);
  return invoice;
}

/**
 * Check if an invoice has been paid
 * In production: Query Voltage/LND for invoice status
 */
function checkInvoice(paymentHash) {
  const invoice = mockInvoices.get(paymentHash);
  if (!invoice) {
    return { status: 'not_found' };
  }
  return invoice;
}

/**
 * Simulate paying an invoice (for testing)
 * In production: This would be triggered by webhook from Voltage
 */
function simulatePayment(paymentHash) {
  const invoice = mockInvoices.get(paymentHash);
  if (invoice && invoice.status === 'pending') {
    invoice.status = 'paid';
    invoice.paid_at = new Date().toISOString();
    return { success: true, invoice };
  }
  return { success: false, error: 'Invoice not found or already paid' };
}

/**
 * Send a Lightning payment for withdrawals
 * In production: Call Voltage API to pay invoice
 */
function payInvoice(paymentRequest, amountSats) {
  const paymentId = uuidv4();
  const payment = {
    id: paymentId,
    payment_request: paymentRequest,
    amount_sats: amountSats,
    status: 'completed', // Mock: instant success
    created_at: new Date().toISOString(),
  };
  
  mockPayments.set(paymentId, payment);
  return payment;
}

/**
 * Get node info
 * In production: Return actual node pubkey and alias
 */
function getNodeInfo() {
  return {
    pubkey: 'mock_03' + 'a'.repeat(64),
    alias: 'Bitcoin Chess 960 Predictions',
    network: 'mainnet',
  };
}

// LNURL-auth challenge generation (mock)
function generateAuthChallenge() {
  const k1 = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  return {
    k1,
    callback: `${process.env.API_URL || 'http://localhost:3001'}/api/auth/lnurl/callback`,
    tag: 'login',
  };
}

module.exports = {
  createInvoice,
  checkInvoice,
  simulatePayment,
  payInvoice,
  getNodeInfo,
  generateAuthChallenge,
  mockInvoices,
};
