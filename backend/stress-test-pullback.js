#!/usr/bin/env node
/**
 * BOT PULLBACK STRESS TEST
 * 
 * Tests the actual atomicPullback() function by:
 * 1. Creating a user and setting them as bot_user_id
 * 2. Bot places NO orders on MULTIPLE markets  
 * 3. Attackers hit ONE market, triggering pullback on OTHERS
 * 4. Subsequent attackers see REDUCED liquidity on other markets
 * 
 * This tests the cascade: Fill → Exposure ↑ → Tier Cross → Pullback → Reduced Liquidity
 */

const http = require('http');
const Database = require('better-sqlite3');

const BASE_URL = process.env.API_URL || 'http://localhost:3001';
const DB_PATH = process.env.DB_PATH || './predictions.db';

// Test configuration
const NUM_MARKETS = 5;
const BOT_ORDER_SIZE = 10000;      // Bot offers 10,000 sats per market (50,000 total)
const BOT_MAX_LOSS = 30000;        // Max loss of 30,000 means pullback kicks in fast
const ATTACK_ORDER_SIZE = 10000;   // Users try to take all liquidity

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
  const email = `pullback-${Date.now()}-${suffix}@test.com`;
  const result = await makeRequest('POST', '/api/auth/demo-login', {
    email,
    username: `pullbackuser${suffix}`
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
  return (sats || 0).toLocaleString() + ' sats';
}

async function runPullbackTest() {
  console.log('═'.repeat(70));
  console.log('⚡ BOT PULLBACK CASCADE STRESS TEST');
  console.log('═'.repeat(70));
  console.log('');
  console.log('📋 Test Configuration:');
  console.log(`   Markets to use:       ${NUM_MARKETS}`);
  console.log(`   Bot order per market: ${formatSats(BOT_ORDER_SIZE)}`);
  console.log(`   Bot max loss:         ${formatSats(BOT_MAX_LOSS)}`);
  console.log(`   Attack order size:    ${formatSats(ATTACK_ORDER_SIZE)}`);
  console.log('');
  console.log('🎯 Expected behavior:');
  console.log('   1. Bot deploys 10k sats on each of 5 markets (50k total exposure)');
  console.log('   2. First attack fills 10k → exposure jumps → triggers pullback');
  console.log('   3. Pullback reduces orders on OTHER markets');
  console.log('   4. Later attacks see less liquidity available');
  console.log('');

  // Direct database access for setup
  const db = new Database(DB_PATH);

  try {
    // Step 1: Create bot user via API
    console.log('━'.repeat(70));
    console.log('📝 STEP 1: Creating bot user...');
    const botAuth = await createTestUser('bot');
    if (!botAuth.token) {
      console.error('❌ Failed to create bot user:', botAuth);
      return;
    }
    console.log(`   ✅ Bot: ${botAuth.user.email}`);
    console.log(`   Balance: ${formatSats(botAuth.user.balance_sats)}`);
    console.log(`   User ID: ${botAuth.user.id}`);

    // Step 2: Configure bot in database (set this user as bot_user_id)
    console.log('\n━'.repeat(70));
    console.log('⚙️  STEP 2: Configuring bot in database...');
    
    // Create or update bot_config
    const existingConfig = db.prepare('SELECT * FROM bot_config WHERE id = ?').get('default');
    if (existingConfig) {
      db.prepare(`
        UPDATE bot_config 
        SET bot_user_id = ?, max_acceptable_loss = ?, threshold_percent = 1.0, is_active = 1
        WHERE id = 'default'
      `).run(botAuth.user.id, BOT_MAX_LOSS);
    } else {
      db.prepare(`
        INSERT INTO bot_config (id, bot_user_id, max_acceptable_loss, total_liquidity, threshold_percent, global_multiplier, is_active)
        VALUES ('default', ?, ?, 100000000, 1.0, 1.0, 1)
      `).run(botAuth.user.id, BOT_MAX_LOSS);
    }
    
    // Initialize exposure tracking
    db.prepare(`
      INSERT OR REPLACE INTO bot_exposure (id, total_at_risk, current_tier)
      VALUES ('default', 0, 0)
    `).run();
    
    console.log(`   ✅ Bot user ID set: ${botAuth.user.id}`);
    console.log(`   ✅ Max loss: ${formatSats(BOT_MAX_LOSS)}`);
    console.log(`   ✅ Threshold: 1% (triggers often)`);

    // Step 3: Get markets
    console.log('\n━'.repeat(70));
    console.log('📊 STEP 3: Getting markets...');
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

    // Step 4: Bot places NO orders on all markets
    console.log('\n━'.repeat(70));
    console.log('🚀 STEP 4: Bot placing NO orders on all markets...');
    
    let totalBotCost = 0;
    const botOrders = [];
    
    for (const market of testMarkets) {
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

    // Step 5: Record initial liquidity
    console.log('\n━'.repeat(70));
    console.log('📊 STEP 5: Recording initial liquidity...');
    
    const initialLiquidity = {};
    for (const market of testMarkets) {
      const orderbook = await getOrderbook(market.attendance_market_id);
      const noLiquidity = orderbook?.no?.reduce((sum, o) => sum + o.amount, 0) || 0;
      initialLiquidity[market.attendance_market_id] = noLiquidity;
      console.log(`   ${market.name}: ${formatSats(noLiquidity)} NO liquidity`);
    }

    // Step 6: Create attackers
    console.log('\n━'.repeat(70));
    console.log('👥 STEP 6: Creating attackers...');
    
    const attackers = [];
    for (let i = 0; i < NUM_MARKETS; i++) {
      const auth = await createTestUser(`attacker${i}`);
      if (auth.token) {
        attackers.push({
          auth,
          targetMarket: testMarkets[i],
          marketIndex: i
        });
        process.stdout.write('.');
      }
    }
    console.log(` Done! ${attackers.length} attackers ready`);

    // Step 7: SEQUENTIAL ATTACKS (to clearly see pullback cascade)
    console.log('\n━'.repeat(70));
    console.log('⚡ STEP 7: SEQUENTIAL ATTACKS (to observe pullback)...');
    console.log('');
    
    const results = [];
    
    for (let i = 0; i < attackers.length; i++) {
      const attacker = attackers[i];
      console.log(`   Attack ${i+1}: ${attacker.targetMarket.name}`);
      
      // Check liquidity BEFORE attack
      const beforeOrderbook = await getOrderbook(attacker.targetMarket.attendance_market_id);
      const beforeLiquidity = beforeOrderbook?.no?.reduce((sum, o) => sum + o.amount, 0) || 0;
      console.log(`      Before: ${formatSats(beforeLiquidity)} NO liquidity`);
      
      // Launch attack
      const result = await placeOrder(
        attacker.auth.token, 
        attacker.targetMarket.attendance_market_id, 
        'yes', 
        60,  // YES@60 matches NO@40+
        ATTACK_ORDER_SIZE
      );
      
      const data = result.data;
      console.log(`      Result: ${data.status} - filled ${formatSats(data.filled || 0)}`);
      
      if (data.pullbackResult) {
        console.log(`      🔥 PULLBACK TRIGGERED!`);
        console.log(`         Tier: ${data.pullbackResult.oldTier} → ${data.pullbackResult.newTier}`);
        console.log(`         Orders modified: ${data.pullbackResult.ordersModified}`);
        console.log(`         Total reduction: ${formatSats(data.pullbackResult.totalReduction)}`);
      }
      
      results.push({
        market: attacker.targetMarket.name,
        beforeLiquidity,
        filled: data.filled || 0,
        status: data.status,
        pullbackTriggered: !!data.pullbackResult,
        pullbackDetails: data.pullbackResult
      });
      
      console.log('');
    }

    // Step 8: Check final liquidity
    console.log('━'.repeat(70));
    console.log('📉 STEP 8: Final liquidity after all attacks...');
    
    const finalLiquidity = {};
    for (const market of testMarkets) {
      const orderbook = await getOrderbook(market.attendance_market_id);
      const noLiquidity = orderbook?.no?.reduce((sum, o) => sum + o.amount, 0) || 0;
      finalLiquidity[market.attendance_market_id] = noLiquidity;
      
      const initial = initialLiquidity[market.attendance_market_id] || 0;
      const reduction = initial - noLiquidity;
      
      console.log(`   ${market.name}:`);
      console.log(`      Before: ${formatSats(initial)} → After: ${formatSats(noLiquidity)}`);
      console.log(`      Reduced by: ${formatSats(reduction)}`);
    }

    // Step 9: Check exposure
    console.log('\n━'.repeat(70));
    console.log('📊 STEP 9: Final bot exposure...');
    
    const exposure = db.prepare('SELECT * FROM bot_exposure WHERE id = ?').get('default');
    console.log(`   Total at risk: ${formatSats(exposure?.total_at_risk || 0)}`);
    console.log(`   Current tier: ${exposure?.current_tier || 0}`);
    console.log(`   Last pullback: ${exposure?.last_pullback_at || 'never'}`);

    // Summary
    console.log('\n' + '═'.repeat(70));
    console.log('📋 FINAL SUMMARY');
    console.log('═'.repeat(70));
    
    const totalFilled = results.reduce((sum, r) => sum + r.filled, 0);
    const pullbackCount = results.filter(r => r.pullbackTriggered).length;
    
    console.log(`   Total attacks: ${results.length}`);
    console.log(`   Total sats filled: ${formatSats(totalFilled)}`);
    console.log(`   Pullbacks triggered: ${pullbackCount}`);
    console.log('');
    
    if (pullbackCount > 0) {
      console.log('✅ PULLBACK MECHANISM CONFIRMED WORKING!');
      console.log('   When bot orders were matched, pullback reduced other markets.');
    } else {
      console.log('⚠️  No pullbacks triggered.');
      console.log('   This could mean:');
      console.log('   - Exposure didn\'t cross tier thresholds');
      console.log('   - Bot orders weren\'t matched (check matching logic)');
    }
    
    // Show pullback events
    results.filter(r => r.pullbackTriggered).forEach((r, i) => {
      console.log(`\n   Pullback ${i+1} on ${r.market}:`);
      console.log(`      Tier change: ${r.pullbackDetails.oldTier} → ${r.pullbackDetails.newTier}`);
      console.log(`      Orders reduced: ${r.pullbackDetails.ordersModified}`);
      console.log(`      Refunded: ${formatSats(r.pullbackDetails.totalRefund)}`);
    });

    console.log('');
    console.log('═'.repeat(70));
    console.log('🎉 Pullback Test Complete!');
    console.log('═'.repeat(70));

  } finally {
    db.close();
  }
}

// Run the test
runPullbackTest().catch(console.error);
