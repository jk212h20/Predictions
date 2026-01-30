#!/usr/bin/env node
/**
 * HTTP Concurrent Stress Test
 * 
 * This test runs against the ACTUAL server with REAL concurrent HTTP requests
 * to verify the db.transaction() protection prevents double-fills.
 * 
 * Usage:
 *   1. Start server: npm start
 *   2. Run test: node stress-test-concurrency.js
 */

const http = require('http');

const BASE_URL = process.env.API_URL || 'http://localhost:3001';
const NUM_CONCURRENT_REQUESTS = 10;
const BOT_LIQUIDITY = 25000;      // Bot offers 25,000 sats
const USER_ORDER_SIZE = 5000;     // Each user tries to buy 5,000 sats
// Expected: ~5 users fully filled, total = 25,000 (partial fills possible)

// Helper to make HTTP requests
function makeRequest(method, path, data, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 3001,
      path: url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { 'Authorization': `Bearer ${token}` })
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function createTestUser(index) {
  const email = `stress-test-${Date.now()}-${index}@test.com`;
  const result = await makeRequest('POST', '/api/auth/demo-login', {
    email,
    username: `stressuser${index}`
  });
  return result.data;
}

async function getUserBalance(token) {
  const result = await makeRequest('GET', '/api/user/balance', null, token);
  return result.data.balance_sats;
}

async function getMarkets() {
  const result = await makeRequest('GET', '/api/grandmasters');
  return result.data;
}

async function placeOrder(token, marketId, side, priceCents, amountSats) {
  const result = await makeRequest('POST', '/api/orders', {
    market_id: marketId,
    side,
    price_cents: priceCents,
    amount_sats: amountSats
  }, token);
  return result;
}

async function runStressTest() {
  console.log('🚀 Starting HTTP Concurrent Stress Test');
  console.log(`📡 Server: ${BASE_URL}`);
  console.log(`👥 Concurrent requests: ${NUM_CONCURRENT_REQUESTS}`);
  console.log('');

  // Step 1: Create bot user (the liquidity provider)
  console.log('📝 Creating bot user...');
  const botAuth = await createTestUser(999);
  if (!botAuth.token) {
    console.error('❌ Failed to create bot user:', botAuth);
    return;
  }
  console.log(`   Bot: ${botAuth.user.email} (balance: ${botAuth.user.balance_sats})`);

  // Step 2: Get a market
  console.log('📊 Getting markets...');
  const markets = await getMarkets();
  if (!markets || markets.length === 0) {
    console.error('❌ No markets found');
    return;
  }
  const market = markets[0];
  console.log(`   Using market: ${market.attendance_market_id} (${market.name})`);

  // Step 3: Bot places a limited NO order (10,000 sats)
  const BOT_ORDER_AMOUNT = 10000;
  console.log(`\n💰 Bot placing NO@40 for ${BOT_ORDER_AMOUNT} sats...`);
  const botOrderResult = await placeOrder(botAuth.token, market.attendance_market_id, 'no', 40, BOT_ORDER_AMOUNT);
  if (botOrderResult.status !== 200) {
    console.error('❌ Bot order failed:', botOrderResult.data);
    return;
  }
  console.log(`   Order ID: ${botOrderResult.data.order_id}`);
  console.log(`   Status: ${botOrderResult.data.status}`);

  // Step 4: Create multiple test users
  console.log(`\n👥 Creating ${NUM_CONCURRENT_REQUESTS} test users...`);
  const users = [];
  for (let i = 0; i < NUM_CONCURRENT_REQUESTS; i++) {
    const auth = await createTestUser(i);
    if (auth.token) {
      users.push(auth);
      process.stdout.write('.');
    }
  }
  console.log(` Done! Created ${users.length} users`);

  // Step 5: All users simultaneously try to buy YES@60 for 10,000 sats each
  console.log(`\n⚡ FIRING ${users.length} CONCURRENT REQUESTS...`);
  console.log('   Each user trying: YES@60 for 10,000 sats');
  console.log('   Bot liquidity: 10,000 sats');
  console.log('   Expected: Only ONE should get filled\n');

  const startTime = Date.now();
  
  // Fire all requests simultaneously
  const promises = users.map(auth => 
    placeOrder(auth.token, market.attendance_market_id, 'yes', 60, 10000)
      .then(result => ({
        user: auth.user.email,
        status: result.data.status,
        filled: result.data.filled,
        remaining: result.data.remaining,
        matched: result.data.matched_bets?.length || 0,
        error: result.data.error
      }))
      .catch(err => ({
        user: auth.user.email,
        error: err.message
      }))
  );

  const results = await Promise.all(promises);
  const elapsed = Date.now() - startTime;

  // Step 6: Analyze results
  console.log('📊 RESULTS:');
  console.log('━'.repeat(60));
  
  const filled = results.filter(r => r.status === 'filled');
  const partial = results.filter(r => r.status === 'partial');
  const open = results.filter(r => r.status === 'open');
  const errors = results.filter(r => r.error);

  console.log(`   Filled:  ${filled.length}`);
  console.log(`   Partial: ${partial.length}`);
  console.log(`   Open:    ${open.length}`);
  console.log(`   Errors:  ${errors.length}`);
  console.log(`   Time:    ${elapsed}ms`);
  console.log('');

  // Calculate total sats matched
  const totalFilled = results.reduce((sum, r) => sum + (r.filled || 0), 0);
  console.log(`   Total sats filled: ${totalFilled}`);
  console.log(`   Bot offered:       ${BOT_ORDER_AMOUNT}`);
  console.log('');

  // Verify integrity
  const PASS = totalFilled === BOT_ORDER_AMOUNT;
  
  if (PASS) {
    console.log('✅ PASS: No double-fill detected!');
    console.log('   Transaction protection is working correctly.');
  } else if (totalFilled > BOT_ORDER_AMOUNT) {
    console.log('❌ FAIL: DOUBLE-FILL DETECTED!');
    console.log(`   ${totalFilled - BOT_ORDER_AMOUNT} extra sats were matched!`);
    console.log('   This indicates a race condition bug.');
  } else {
    console.log('⚠️  WARN: Less than expected was filled');
    console.log('   This might indicate a different issue.');
  }

  // Show details for filled orders
  if (filled.length > 0 || partial.length > 0) {
    console.log('\n📝 Filled/Partial Orders:');
    [...filled, ...partial].forEach(r => {
      console.log(`   - ${r.user}: ${r.status} (${r.filled} sats, ${r.matched} bets)`);
    });
  }

  if (errors.length > 0) {
    console.log('\n⚠️  Errors:');
    errors.forEach(r => {
      console.log(`   - ${r.user}: ${r.error}`);
    });
  }

  console.log('\n' + '═'.repeat(60));
  console.log(PASS ? '🎉 Stress Test PASSED!' : '💥 Stress Test FAILED!');
  console.log('═'.repeat(60));
}

// Run the test
runStressTest().catch(console.error);
