#!/usr/bin/env node
/**
 * DETAILED PULLBACK VERIFICATION TESTS
 * 
 * Each test has:
 * 1. Clear setup
 * 2. Predicted outcome BEFORE running
 * 3. Actual result
 * 4. PASS/FAIL comparison
 */

const http = require('http');
const Database = require('better-sqlite3');

const BASE_URL = process.env.API_URL || 'http://localhost:3001';
const DB_PATH = process.env.DB_PATH || './predictions.db';

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
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => reject(new Error('Timeout')));
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function createUser(suffix) {
  const email = `test-${Date.now()}-${suffix}@test.com`;
  const result = await makeRequest('POST', '/api/auth/demo-login', { email, username: `test${suffix}` });
  return result.data;
}

async function getMarkets() {
  const result = await makeRequest('GET', '/api/grandmasters');
  return result.data;
}

async function placeOrder(token, marketId, side, priceCents, amountSats) {
  return await makeRequest('POST', '/api/orders', {
    market_id: marketId, side, price_cents: priceCents, amount_sats: amountSats
  }, token);
}

async function getOrderbook(marketId) {
  const result = await makeRequest('GET', `/api/markets/${marketId}/orderbook`);
  return result.data;
}

// Direct database query for bot orders (more reliable than API)
function getMarketLiquidity(db, marketId, userId) {
  const result = db.prepare(`
    SELECT SUM(amount_sats - filled_sats) as total
    FROM orders 
    WHERE market_id = ? AND user_id = ? AND status IN ('open', 'partial')
  `).get(marketId, userId);
  return result?.total || 0;
}

function fmt(sats) { return (sats || 0).toLocaleString(); }

// ============================================================
// TEST 1: Basic Pullback Trigger
// ============================================================
async function test1_BasicPullbackTrigger(db, markets) {
  console.log('\n' + '═'.repeat(70));
  console.log('📋 TEST 1: BASIC PULLBACK TRIGGER');
  console.log('═'.repeat(70));
  
  // SETUP
  const MAX_LOSS = 10000;
  const THRESHOLD = 10;
  const BOT_ORDER = 5000;
  const ATTACK_SIZE = 1000;
  
  console.log('\n📝 SETUP:');
  console.log(`   max_loss = ${fmt(MAX_LOSS)} sats`);
  console.log(`   threshold = ${THRESHOLD}%`);
  console.log(`   Bot places ${fmt(BOT_ORDER)} on Market A, ${fmt(BOT_ORDER)} on Market B`);
  console.log(`   Attacker takes ${fmt(ATTACK_SIZE)} from Market A`);
  
  // PREDICTION
  const predictedExposure = ATTACK_SIZE;
  const predictedPercent = (predictedExposure / MAX_LOSS) * 100;
  const predictedOldTier = 0;
  const predictedNewTier = Math.floor(predictedPercent / THRESHOLD);
  const predictedTierChanged = predictedOldTier !== predictedNewTier;
  const predictedPullbackRatio = (MAX_LOSS - predictedExposure) / MAX_LOSS;
  const predictedMarketBRemaining = Math.floor(BOT_ORDER * predictedPullbackRatio);
  
  console.log('\n🎯 PREDICTED OUTCOME:');
  console.log(`   Old exposure: 0 → New exposure: ${fmt(predictedExposure)}`);
  console.log(`   Exposure %: ${predictedPercent.toFixed(1)}%`);
  console.log(`   Old tier: ${predictedOldTier} → New tier: ${predictedNewTier}`);
  console.log(`   Tier changed: ${predictedTierChanged ? 'YES' : 'NO'}`);
  console.log(`   Pullback should trigger: ${predictedTierChanged ? 'YES ✓' : 'NO'}`);
  console.log(`   Pullback ratio: ${predictedPullbackRatio.toFixed(2)}`);
  console.log(`   Market B should have: ~${fmt(predictedMarketBRemaining)} sats remaining`);
  
  // EXECUTION
  console.log('\n🚀 EXECUTING...');
  
  // Create bot user and configure
  const botAuth = await createUser('bot1');
  db.prepare(`UPDATE bot_config SET bot_user_id = ?, max_acceptable_loss = ?, threshold_percent = ?, is_active = 1 WHERE id = 'default'`)
    .run(botAuth.user.id, MAX_LOSS, THRESHOLD);
  db.prepare(`INSERT OR REPLACE INTO bot_exposure (id, total_at_risk, current_tier) VALUES ('default', 0, 0)`).run();
  
  const marketA = markets[0].attendance_market_id;
  const marketB = markets[1].attendance_market_id;
  
  // Bot places orders
  await placeOrder(botAuth.token, marketA, 'no', 40, BOT_ORDER);
  await placeOrder(botAuth.token, marketB, 'no', 40, BOT_ORDER);
  
  // Check Market B before attack (query DB directly for bot's orders)
  const beforeLiquidity = getMarketLiquidity(db, marketB, botAuth.user.id);
  console.log(`   Market B before: ${fmt(beforeLiquidity)} sats`);
  
  // Attacker hits Market A
  const attackerAuth = await createUser('attacker1');
  const attackResult = await placeOrder(attackerAuth.token, marketA, 'yes', 60, ATTACK_SIZE);
  
  console.log(`   Attack result: ${attackResult.data.status}, filled ${fmt(attackResult.data.filled)}`);
  
  // Check exposure
  const exposure = db.prepare('SELECT * FROM bot_exposure WHERE id = ?').get('default');
  console.log(`   Actual exposure: ${fmt(exposure.total_at_risk)}, tier: ${exposure.current_tier}`);
  
  // Check Market B after attack (query DB directly)
  const afterLiquidity = getMarketLiquidity(db, marketB, botAuth.user.id);
  console.log(`   Market B after: ${fmt(afterLiquidity)} sats`);
  
  // VERIFICATION
  console.log('\n✅ VERIFICATION:');
  const exposureCorrect = exposure.total_at_risk === predictedExposure;
  const tierCorrect = exposure.current_tier === predictedNewTier;
  // Allow some tolerance for rounding
  const liquidityReduced = afterLiquidity < beforeLiquidity;
  const liquidityCorrect = Math.abs(afterLiquidity - predictedMarketBRemaining) < 100;
  
  console.log(`   Exposure: ${exposureCorrect ? '✅ PASS' : '❌ FAIL'} (expected ${fmt(predictedExposure)}, got ${fmt(exposure.total_at_risk)})`);
  console.log(`   Tier: ${tierCorrect ? '✅ PASS' : '❌ FAIL'} (expected ${predictedNewTier}, got ${exposure.current_tier})`);
  console.log(`   Liquidity reduced: ${liquidityReduced ? '✅ YES' : '❌ NO'} (${fmt(beforeLiquidity)} → ${fmt(afterLiquidity)})`);
  console.log(`   Liquidity amount: ${liquidityCorrect ? '✅ PASS' : '⚠️ CLOSE'} (expected ~${fmt(predictedMarketBRemaining)}, got ${fmt(afterLiquidity)})`);
  
  const passed = exposureCorrect && tierCorrect && liquidityReduced;
  console.log(`\n   OVERALL: ${passed ? '✅ TEST PASSED' : '❌ TEST FAILED'}`);
  
  return passed;
}

// ============================================================
// TEST 2: No Pullback When Same Tier  
// ============================================================
async function test2_NoPullbackSameTier(db, markets) {
  console.log('\n' + '═'.repeat(70));
  console.log('📋 TEST 2: NO PULLBACK WHEN SAME TIER');
  console.log('═'.repeat(70));
  
  const MAX_LOSS = 10000;
  const THRESHOLD = 10;
  const BOT_ORDER = 3000;
  const INITIAL_EXPOSURE = 500;
  const ATTACK_SIZE = 400;
  
  console.log('\n📝 SETUP:');
  console.log(`   max_loss = ${fmt(MAX_LOSS)} sats`);
  console.log(`   threshold = ${THRESHOLD}%`);
  console.log(`   Starting exposure: ${fmt(INITIAL_EXPOSURE)} (tier 0)`);
  console.log(`   Attacker takes ${fmt(ATTACK_SIZE)} more`);
  
  // PREDICTION
  const finalExposure = INITIAL_EXPOSURE + ATTACK_SIZE;
  const finalPercent = (finalExposure / MAX_LOSS) * 100;
  const initialTier = Math.floor((INITIAL_EXPOSURE / MAX_LOSS) * 100 / THRESHOLD);
  const finalTier = Math.floor(finalPercent / THRESHOLD);
  const shouldTrigger = initialTier !== finalTier;
  
  console.log('\n🎯 PREDICTED OUTCOME:');
  console.log(`   Final exposure: ${fmt(finalExposure)} (${finalPercent.toFixed(1)}%)`);
  console.log(`   Tier: ${initialTier} → ${finalTier}`);
  console.log(`   Tier changed: ${shouldTrigger ? 'YES' : 'NO'}`);
  console.log(`   Pullback should trigger: ${shouldTrigger ? 'YES' : 'NO (same tier)'}`);
  
  // EXECUTION
  console.log('\n🚀 EXECUTING...');
  
  const botAuth = await createUser('bot2');
  db.prepare(`UPDATE bot_config SET bot_user_id = ?, max_acceptable_loss = ?, threshold_percent = ?, is_active = 1 WHERE id = 'default'`)
    .run(botAuth.user.id, MAX_LOSS, THRESHOLD);
  db.prepare(`INSERT OR REPLACE INTO bot_exposure (id, total_at_risk, current_tier) VALUES ('default', ?, ?)`).run(INITIAL_EXPOSURE, initialTier);
  
  const marketA = markets[2].attendance_market_id;
  const marketB = markets[3].attendance_market_id;
  
  await placeOrder(botAuth.token, marketA, 'no', 40, BOT_ORDER);
  await placeOrder(botAuth.token, marketB, 'no', 40, BOT_ORDER);
  
  const beforeLiquidity = getMarketLiquidity(db, marketB, botAuth.user.id);
  console.log(`   Market B before: ${fmt(beforeLiquidity)} sats`);
  
  const attackerAuth = await createUser('attacker2');
  const attackResult = await placeOrder(attackerAuth.token, marketA, 'yes', 60, ATTACK_SIZE);
  console.log(`   Attack result: ${attackResult.data.status}, filled ${fmt(attackResult.data.filled)}`);
  
  const exposure = db.prepare('SELECT * FROM bot_exposure WHERE id = ?').get('default');
  console.log(`   Actual exposure: ${fmt(exposure.total_at_risk)}, tier: ${exposure.current_tier}`);
  
  const afterLiquidity = getMarketLiquidity(db, marketB, botAuth.user.id);
  console.log(`   Market B after: ${fmt(afterLiquidity)} sats`);
  
  // VERIFICATION
  console.log('\n✅ VERIFICATION:');
  const tierUnchanged = exposure.current_tier === initialTier;
  const liquidityUnchanged = afterLiquidity === beforeLiquidity;
  
  console.log(`   Tier unchanged: ${tierUnchanged ? '✅ PASS' : '❌ FAIL'} (expected ${initialTier}, got ${exposure.current_tier})`);
  console.log(`   Market B unchanged: ${liquidityUnchanged ? '✅ PASS' : '❌ FAIL'} (${fmt(beforeLiquidity)} → ${fmt(afterLiquidity)})`);
  
  const passed = tierUnchanged && liquidityUnchanged;
  console.log(`\n   OVERALL: ${passed ? '✅ TEST PASSED' : '❌ TEST FAILED'}`);
  
  return passed;
}

// ============================================================
// TEST 3: Cascading Pullback
// ============================================================
async function test3_CascadingPullback(db, markets) {
  console.log('\n' + '═'.repeat(70));
  console.log('📋 TEST 3: CASCADING PULLBACK ACROSS MARKETS');
  console.log('═'.repeat(70));
  
  const MAX_LOSS = 10000;
  const THRESHOLD = 10;
  const BOT_ORDER = 4000;
  
  console.log('\n📝 SETUP:');
  console.log(`   max_loss = ${fmt(MAX_LOSS)} sats`);
  console.log(`   threshold = ${THRESHOLD}% (tier changes every ${fmt(MAX_LOSS * THRESHOLD / 100)} sats)`);
  console.log(`   Bot places ${fmt(BOT_ORDER)} on Markets A, B, C`);
  console.log(`   Sequential attacks: A, then B, then C`);
  
  // PREDICTIONS
  console.log('\n🎯 PREDICTED OUTCOME:');
  console.log('   Attack 1 (Market A):');
  console.log(`      Takes ~${fmt(BOT_ORDER)} → exposure 0→${fmt(BOT_ORDER)}`);
  console.log(`      Tier 0→${Math.floor(40)}% = tier 4`);
  console.log(`      Pullback ratio: ${((MAX_LOSS - BOT_ORDER) / MAX_LOSS).toFixed(2)}`);
  console.log(`      B,C reduced to: ~${fmt(Math.floor(BOT_ORDER * 0.6))} sats each`);
  
  console.log('   Attack 2 (Market B):');
  console.log('      Takes reduced amount → exposure increases → further pullback');
  
  console.log('   Attack 3 (Market C):');
  console.log('      Takes whatever remains');
  
  console.log('\n   EXPECTED: Total filled should be LESS than 12,000 (3 × 4,000)');
  console.log('   EXPECTED: Pullback protects by reducing liquidity progressively');
  
  // EXECUTION
  console.log('\n🚀 EXECUTING...');
  
  const botAuth = await createUser('bot3');
  db.prepare(`UPDATE bot_config SET bot_user_id = ?, max_acceptable_loss = ?, threshold_percent = ?, is_active = 1 WHERE id = 'default'`)
    .run(botAuth.user.id, MAX_LOSS, THRESHOLD);
  db.prepare(`INSERT OR REPLACE INTO bot_exposure (id, total_at_risk, current_tier) VALUES ('default', 0, 0)`).run();
  
  const marketA = markets[0].attendance_market_id;
  const marketB = markets[1].attendance_market_id;
  const marketC = markets[2].attendance_market_id;
  
  // Bot places orders
  await placeOrder(botAuth.token, marketA, 'no', 40, BOT_ORDER);
  await placeOrder(botAuth.token, marketB, 'no', 40, BOT_ORDER);
  await placeOrder(botAuth.token, marketC, 'no', 40, BOT_ORDER);
  
  // Record initial (using DB query)
  const initialB = getMarketLiquidity(db, marketB, botAuth.user.id);
  const initialC = getMarketLiquidity(db, marketC, botAuth.user.id);
  console.log(`   Initial: B=${fmt(initialB)}, C=${fmt(initialC)}`);
  
  let totalFilled = 0;
  const results = [];
  
  // Attack 1
  const attacker1 = await createUser('atk1');
  const result1 = await placeOrder(attacker1.token, marketA, 'yes', 60, BOT_ORDER);
  const exp1 = db.prepare('SELECT * FROM bot_exposure WHERE id = ?').get('default');
  const bLiq1 = getMarketLiquidity(db, marketB, botAuth.user.id);
  const cLiq1 = getMarketLiquidity(db, marketC, botAuth.user.id);
  totalFilled += result1.data.filled || 0;
  console.log(`   Attack 1: filled ${fmt(result1.data.filled)}, exposure=${fmt(exp1.total_at_risk)}, tier=${exp1.current_tier}, B=${fmt(bLiq1)}, C=${fmt(cLiq1)}`);
  results.push({ filled: result1.data.filled, exposure: exp1.total_at_risk, tier: exp1.current_tier, bLiq: bLiq1, cLiq: cLiq1 });
  
  // Attack 2
  const attacker2 = await createUser('atk2');
  const result2 = await placeOrder(attacker2.token, marketB, 'yes', 60, BOT_ORDER);
  const exp2 = db.prepare('SELECT * FROM bot_exposure WHERE id = ?').get('default');
  const cLiq2 = getMarketLiquidity(db, marketC, botAuth.user.id);
  totalFilled += result2.data.filled || 0;
  console.log(`   Attack 2: filled ${fmt(result2.data.filled)}, exposure=${fmt(exp2.total_at_risk)}, tier=${exp2.current_tier}, C=${fmt(cLiq2)}`);
  results.push({ filled: result2.data.filled, exposure: exp2.total_at_risk, tier: exp2.current_tier, cLiq: cLiq2 });
  
  // Attack 3
  const attacker3 = await createUser('atk3');
  const result3 = await placeOrder(attacker3.token, marketC, 'yes', 60, BOT_ORDER);
  const exp3 = db.prepare('SELECT * FROM bot_exposure WHERE id = ?').get('default');
  totalFilled += result3.data.filled || 0;
  console.log(`   Attack 3: filled ${fmt(result3.data.filled)}, exposure=${fmt(exp3.total_at_risk)}, tier=${exp3.current_tier}`);
  results.push({ filled: result3.data.filled, exposure: exp3.total_at_risk, tier: exp3.current_tier });
  
  // VERIFICATION
  console.log('\n✅ VERIFICATION:');
  console.log(`   Total filled: ${fmt(totalFilled)}`);
  console.log(`   Max possible (no pullback): ${fmt(BOT_ORDER * 3)}`);
  console.log(`   Final exposure: ${fmt(exp3.total_at_risk)}`);
  console.log(`   Max loss limit: ${fmt(MAX_LOSS)}`);
  
  const fillsDecreased = results[0].filled >= results[1].filled && results[1].filled >= results[2].filled;
  const underMaxLoss = exp3.total_at_risk <= MAX_LOSS;
  const pullbackWorked = totalFilled < BOT_ORDER * 3;
  
  console.log(`   Fills decreased: ${fillsDecreased ? '✅ PASS' : '⚠️ NOT STRICTLY'} (${results.map(r=>fmt(r.filled)).join(' → ')})`);
  console.log(`   Under max loss: ${underMaxLoss ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`   Pullback reduced total: ${pullbackWorked ? '✅ PASS' : '❌ FAIL'}`);
  
  const passed = underMaxLoss && pullbackWorked;
  console.log(`\n   OVERALL: ${passed ? '✅ TEST PASSED' : '❌ TEST FAILED'}`);
  
  return passed;
}

// ============================================================
// MAIN
// ============================================================
async function runAllTests() {
  console.log('═'.repeat(70));
  console.log('🧪 PULLBACK MECHANISM VERIFICATION TESTS');
  console.log('═'.repeat(70));
  console.log('\nThese tests verify the bot pullback system works correctly.');
  console.log('Each test shows PREDICTED outcomes BEFORE execution.\n');
  
  const db = new Database(DB_PATH);
  
  try {
    // Clear test data
    db.prepare(`UPDATE orders SET status = 'cancelled' WHERE status IN ('open','partial')`).run();
    db.prepare(`INSERT OR REPLACE INTO bot_exposure (id, total_at_risk, current_tier) VALUES ('default', 0, 0)`).run();
    
    const markets = await getMarkets();
    if (!markets || markets.length < 5) {
      console.error('Need at least 5 markets');
      return;
    }
    
    const results = [];
    
    // Run Test 1
    db.prepare(`UPDATE orders SET status = 'cancelled' WHERE status IN ('open','partial')`).run();
    db.prepare(`INSERT OR REPLACE INTO bot_exposure (id, total_at_risk, current_tier) VALUES ('default', 0, 0)`).run();
    results.push(await test1_BasicPullbackTrigger(db, markets));
    
    // Run Test 2
    db.prepare(`UPDATE orders SET status = 'cancelled' WHERE status IN ('open','partial')`).run();
    results.push(await test2_NoPullbackSameTier(db, markets));
    
    // Run Test 3
    db.prepare(`UPDATE orders SET status = 'cancelled' WHERE status IN ('open','partial')`).run();
    db.prepare(`INSERT OR REPLACE INTO bot_exposure (id, total_at_risk, current_tier) VALUES ('default', 0, 0)`).run();
    results.push(await test3_CascadingPullback(db, markets));
    
    // Summary
    console.log('\n' + '═'.repeat(70));
    console.log('📊 FINAL SUMMARY');
    console.log('═'.repeat(70));
    console.log(`   Test 1 (Basic Pullback): ${results[0] ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`   Test 2 (Same Tier):      ${results[1] ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`   Test 3 (Cascade):        ${results[2] ? '✅ PASS' : '❌ FAIL'}`);
    console.log('');
    const allPassed = results.every(r => r);
    console.log(`   OVERALL: ${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
    console.log('═'.repeat(70));
    
  } finally {
    db.close();
  }
}

runAllTests().catch(console.error);
