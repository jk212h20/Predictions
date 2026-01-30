#!/usr/bin/env node
/**
 * MULTI-MARKET CASCADE STRESS TEST
 * 
 * Tests realistic scenario with liquidity spread across multiple markets:
 * 
 * 1. "Bot" user places NO orders across MULTIPLE markets
 * 2. Multiple users fire concurrent orders at DIFFERENT markets
 * 3. First fills consume liquidity on their markets
 * 4. Other users may see reduced availability → partial fills
 * 5. Tests that order matching is atomic and correct
 * 
 * Note: This test doesn't use the actual bot pullback mechanism (which requires admin)
 * but tests the core concurrent matching scenario with partial fills.
 */

const http = require('http');

const BASE_URL = process.env.API_URL || 'http://localhost:3001';

// Test configuration
const NUM_MARKETS = 5;              // Use 5 different markets
const USERS_PER_MARKET = 3;         // 3 users attack each market
const USER_ORDER_SIZE = 4000;       // Each user order is 4,000 sats
const BOT_ORDER_SIZE = 5000;        // Bot offers 5,000 sats per market (only 1+ users can fully fill)

// Helper to make HTTP requests
function makeRequest(method, path, data, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 3001,
      path: url.pathname + (url.search || ''),
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
    req.setTimeout(10000, () => reject(new Error('Request timeout')));
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function createTestUser(suffix) {
  const email = `cascade-${Date.now()}-${suffix}@test.com`;
  const result = await makeRequest('POST', '/api/auth/demo-login', {
    email,
    username: `cascadeuser${suffix}`
  });
  return result.data;
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

async function getOrderbook(marketId) {
  const result = await makeRequest('GET', `/api/markets/${marketId}/orderbook`);
  return result.data;
}

function formatSats(sats) {
  return sats?.toLocaleString() + ' sats';
}

async function runCascadeTest() {
  console.log('═'.repeat(70));
  console.log('🌊 MULTI-MARKET CONCURRENT PARTIAL FILL TEST');
  console.log('═'.repeat(70));
  console.log('');
  console.log('📋 Test Configuration:');
  console.log(`   Markets to use:       ${NUM_MARKETS}`);
  console.log(`   Users per market:     ${USERS_PER_MARKET}`);
  console.log(`   User order size:      ${formatSats(USER_ORDER_SIZE)}`);
  console.log(`   Bot order per market: ${formatSats(BOT_ORDER_SIZE)}`);
  console.log(`   Total user demand:    ${formatSats(NUM_MARKETS * USERS_PER_MARKET * USER_ORDER_SIZE)}`);
  console.log(`   Total bot liquidity:  ${formatSats(NUM_MARKETS * BOT_ORDER_SIZE)}`);
  console.log('');
  console.log('⚠️  Each market has only 5,000 sats liquidity');
  console.log('   3 users each want 4,000 sats (12,000 total)');
  console.log('   Expected: 1 full fill + 1 partial fill + 1 open per market');
  console.log('');

  // Step 1: Create bot user
  console.log('━'.repeat(70));
  console.log('📝 STEP 1: Creating bot user...');
  const botAuth = await createTestUser('bot');
  if (!botAuth.token) {
    console.error('❌ Failed to create bot user:', botAuth);
    return;
  }
  console.log(`   ✅ Bot: ${botAuth.user.email}`);
  console.log(`   Balance: ${formatSats(botAuth.user.balance_sats)}`);

  // Step 2: Get markets
  console.log('\n━'.repeat(70));
  console.log('📊 STEP 2: Getting markets...');
  const allMarkets = await getMarkets();
  if (!allMarkets || allMarkets.length < NUM_MARKETS) {
    console.error(`❌ Not enough markets. Found ${allMarkets?.length || 0}, need ${NUM_MARKETS}`);
    return;
  }
  
  const testMarkets = allMarkets.slice(0, NUM_MARKETS);
  console.log(`   Using ${testMarkets.length} markets:`);
  testMarkets.forEach((m, i) => {
    console.log(`   ${i+1}. ${m.name} (${m.attendance_market_id.slice(0,8)}...)`);
  });

  // Step 3: Bot places NO orders on each market
  console.log('\n━'.repeat(70));
  console.log('🚀 STEP 3: Bot placing NO orders on each market...');
  
  let totalBotCost = 0;
  const botOrders = [];
  
  for (const market of testMarkets) {
    // Place NO@40 (means YES takers need YES@60+ to match)
    const result = await placeOrder(
      botAuth.token, 
      market.attendance_market_id, 
      'no', 
      40,  // NO@40 
      BOT_ORDER_SIZE
    );
    
    if (result.data?.order_id) {
      botOrders.push({
        marketId: market.attendance_market_id,
        marketName: market.name,
        orderId: result.data.order_id,
        amount: BOT_ORDER_SIZE,
        cost: result.data.cost
      });
      totalBotCost += result.data.cost || 0;
      console.log(`   ✅ ${market.name}: NO@40 for ${formatSats(BOT_ORDER_SIZE)}`);
    } else {
      console.log(`   ❌ ${market.name}: Failed - ${result.data?.error || 'unknown'}`);
    }
  }
  
  console.log(`\n   Total bot orders: ${botOrders.length}`);
  console.log(`   Total bot cost: ${formatSats(totalBotCost)}`);

  // Step 4: Record initial liquidity per market
  console.log('\n━'.repeat(70));
  console.log('📊 STEP 4: Recording initial liquidity...');
  
  const initialLiquidity = {};
  for (const market of testMarkets) {
    const orderbook = await getOrderbook(market.attendance_market_id);
    const noLiquidity = orderbook?.no?.reduce((sum, o) => sum + o.amount, 0) || 0;
    initialLiquidity[market.attendance_market_id] = noLiquidity;
    console.log(`   ${market.name}: ${formatSats(noLiquidity)} NO liquidity`);
  }

  // Step 5: Create attacker users
  console.log('\n━'.repeat(70));
  console.log(`👥 STEP 5: Creating ${NUM_MARKETS * USERS_PER_MARKET} attacker users...`);
  
  const attackers = [];
  for (let m = 0; m < NUM_MARKETS; m++) {
    for (let u = 0; u < USERS_PER_MARKET; u++) {
      const auth = await createTestUser(`m${m}u${u}`);
      if (auth.token) {
        attackers.push({
          auth,
          targetMarket: testMarkets[m],
          marketIndex: m,
          userIndex: u
        });
        process.stdout.write('.');
      }
    }
  }
  console.log(` Done! ${attackers.length} users ready`);

  // Step 6: FIRE CONCURRENT ATTACKS
  console.log('\n━'.repeat(70));
  console.log('⚡ STEP 6: FIRING CONCURRENT ATTACKS...');
  console.log(`   ${attackers.length} users attacking ${NUM_MARKETS} markets simultaneously`);
  console.log(`   Each user placing YES@60 for ${formatSats(USER_ORDER_SIZE)}`);
  console.log('');

  const startTime = Date.now();
  
  // Fire all requests simultaneously
  const promises = attackers.map((attacker, idx) => 
    placeOrder(
      attacker.auth.token, 
      attacker.targetMarket.attendance_market_id, 
      'yes', 
      60,  // YES@60 matches NO@40+
      USER_ORDER_SIZE
    )
    .then(result => ({
      attackerIndex: idx,
      market: attacker.targetMarket.name,
      marketIndex: attacker.marketIndex,
      userIndex: attacker.userIndex,
      status: result.data?.status,
      filled: result.data?.filled || 0,
      remaining: result.data?.remaining,
      matched: result.data?.matched_bets?.length || 0,
      error: result.data?.error,
      raw: result.data
    }))
    .catch(err => ({
      attackerIndex: idx,
      market: attacker.targetMarket.name,
      error: err.message
    }))
  );

  const results = await Promise.all(promises);
  const elapsed = Date.now() - startTime;

  // Step 7: Analyze results
  console.log('\n━'.repeat(70));
  console.log('📊 STEP 7: ANALYZING RESULTS');
  console.log('━'.repeat(70));
  console.log(`   Total time: ${elapsed}ms`);
  console.log('');

  // Group by market
  const byMarket = {};
  for (const result of results) {
    if (!byMarket[result.market]) {
      byMarket[result.market] = [];
    }
    byMarket[result.market].push(result);
  }

  // Stats per market
  let totalFilled = 0;
  let totalOrders = 0;
  let filledCount = 0;
  let partialCount = 0;
  let openCount = 0;

  console.log('📈 Results by Market:');
  console.log('');
  
  for (const [marketName, marketResults] of Object.entries(byMarket)) {
    const market = testMarkets.find(m => m.name === marketName);
    const initialLiq = initialLiquidity[market?.attendance_market_id] || 0;
    
    const filled = marketResults.filter(r => r.status === 'filled');
    const partial = marketResults.filter(r => r.status === 'partial');
    const open = marketResults.filter(r => r.status === 'open');
    const errors = marketResults.filter(r => r.error && !r.status);
    
    const marketFilled = marketResults.reduce((sum, r) => sum + (r.filled || 0), 0);
    
    console.log(`   📌 ${marketName}`);
    console.log(`      Bot liquidity: ${formatSats(initialLiq)}`);
    console.log(`      Results: ${filled.length} filled, ${partial.length} partial, ${open.length} open, ${errors.length} errors`);
    console.log(`      Total sats filled: ${formatSats(marketFilled)}`);
    
    // Show all results with details
    marketResults.forEach((r, i) => {
      const icon = r.status === 'filled' ? '✅' : r.status === 'partial' ? '⚡' : '📋';
      console.log(`      ${icon} User ${r.userIndex}: ${r.status || 'error'} - filled ${formatSats(r.filled || 0)}, remaining ${r.remaining || 0}`);
    });
    console.log('');
    
    totalFilled += marketFilled;
    totalOrders += marketResults.length;
    filledCount += filled.length;
    partialCount += partial.length;
    openCount += open.length;
  }

  // Step 8: Check final liquidity
  console.log('━'.repeat(70));
  console.log('📉 STEP 8: Final liquidity after attack...');
  
  const finalLiquidity = {};
  for (const market of testMarkets) {
    const orderbook = await getOrderbook(market.attendance_market_id);
    const noLiquidity = orderbook?.no?.reduce((sum, o) => sum + o.amount, 0) || 0;
    finalLiquidity[market.attendance_market_id] = noLiquidity;
    
    const initial = initialLiquidity[market.attendance_market_id] || 0;
    const consumed = initial - noLiquidity;
    const consumedPct = initial > 0 ? ((consumed / initial) * 100).toFixed(1) : 0;
    
    console.log(`   ${market.name}:`);
    console.log(`      Before: ${formatSats(initial)} → After: ${formatSats(noLiquidity)}`);
    console.log(`      Consumed: ${formatSats(consumed)} (${consumedPct}%)`);
  }

  // Final summary
  console.log('\n' + '═'.repeat(70));
  console.log('📋 FINAL SUMMARY');
  console.log('═'.repeat(70));
  console.log(`   Total orders placed:    ${totalOrders}`);
  console.log(`   Orders fully filled:    ${filledCount}`);
  console.log(`   Orders partial:         ${partialCount}`);
  console.log(`   Orders open (no match): ${openCount}`);
  console.log(`   Total sats matched:     ${formatSats(totalFilled)}`);
  console.log(`   Execution time:         ${elapsed}ms`);
  console.log('');
  
  // Expected vs Actual
  const expectedFilledPerMarket = BOT_ORDER_SIZE;
  const expectedTotalFilled = NUM_MARKETS * expectedFilledPerMarket;
  
  console.log('📊 Validation:');
  console.log(`   Expected total fill: ${formatSats(expectedTotalFilled)} (${NUM_MARKETS} × ${formatSats(BOT_ORDER_SIZE)})`);
  console.log(`   Actual total fill:   ${formatSats(totalFilled)}`);
  
  if (totalFilled === expectedTotalFilled) {
    console.log('   ✅ PASS: Total fill matches bot liquidity exactly!');
  } else if (totalFilled > expectedTotalFilled) {
    console.log(`   ❌ FAIL: Over-fill detected! ${formatSats(totalFilled - expectedTotalFilled)} extra`);
  } else {
    console.log(`   ⚠️  Under-fill: ${formatSats(expectedTotalFilled - totalFilled)} less than expected`);
  }
  
  // Check partial fills happened
  if (partialCount > 0) {
    console.log('   ✅ PARTIAL FILLS confirmed - concurrent requests handled correctly!');
  } else if (filledCount > 0) {
    console.log('   ℹ️  No partial fills - users may have been fully serialized');
  }

  console.log('');
  console.log('═'.repeat(70));
  console.log('🎉 Multi-Market Test Complete!');
  console.log('═'.repeat(70));
}

// Run the test
runCascadeTest().catch(console.error);
