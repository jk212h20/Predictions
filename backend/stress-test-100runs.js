#!/usr/bin/env node
/**
 * 100 SEPARATE TEST RUNS
 * 
 * Each test:
 * - 30 markets
 * - 3M total liquidity
 * - 200k max loss
 * - Random attacks until liquidity exhausted
 * - Report total filled
 */

const http = require('http');
const Database = require('better-sqlite3');

const BASE_URL = process.env.API_URL || 'http://localhost:3001';
const DB_PATH = process.env.DB_PATH || './predictions.db';

const TOTAL_LIQUIDITY = 3000000;  // 3M sats
const MAX_LOSS = 200000;          // 200k max loss
const NUM_MARKETS = 30;
const NUM_TESTS = 100;
const MIN_ATTACK = 5000;
const MAX_ATTACK = 100000;

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
  const email = `t${Date.now()}-${suffix}@t.com`;
  const result = await makeRequest('POST', '/api/auth/demo-login', { email, username: `t${suffix}` });
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

function fmt(sats) { return (sats || 0).toLocaleString(); }

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function runSingleTest(db, testNum, testMarkets) {
  // Reset for fresh test
  db.prepare(`UPDATE orders SET status = 'cancelled' WHERE status IN ('open','partial')`).run();
  db.prepare(`INSERT OR REPLACE INTO bot_exposure (id, total_at_risk, current_tier) VALUES ('default', 0, 0)`).run();
  
  // Create bot user
  const botAuth = await createUser(`bot${testNum}`);
  if (!botAuth.token) return { filled: 0, attacks: 0 };
  
  db.prepare('UPDATE users SET balance_sats = ? WHERE id = ?').run(TOTAL_LIQUIDITY * 2, botAuth.user.id);
  
  db.prepare(`
    UPDATE bot_config 
    SET bot_user_id = ?, max_acceptable_loss = ?, total_liquidity = ?, threshold_percent = 10, global_multiplier = 1, is_active = 1 
    WHERE id = 'default'
  `).run(botAuth.user.id, MAX_LOSS, TOTAL_LIQUIDITY);
  
  // Deploy liquidity
  const perMarket = Math.floor(TOTAL_LIQUIDITY / NUM_MARKETS);
  const prices = [5, 10, 15, 20, 25, 30];
  const perPrice = Math.floor(perMarket / prices.length);
  
  for (const market of testMarkets) {
    for (const price of prices) {
      await placeOrder(botAuth.token, market.attendance_market_id, 'no', price, perPrice);
    }
  }
  
  // Run attacks until exhausted
  let totalFilled = 0;
  let attacks = 0;
  let consecutiveZeros = 0;
  
  while (consecutiveZeros < 10) { // Stop after 10 consecutive zero fills
    attacks++;
    const marketIdx = randomInt(0, NUM_MARKETS - 1);
    const market = testMarkets[marketIdx];
    const attackAmount = randomInt(MIN_ATTACK, MAX_ATTACK);
    
    const attackerAuth = await createUser(`a${testNum}_${attacks}`);
    if (!attackerAuth.token) continue;
    
    const result = await placeOrder(attackerAuth.token, market.attendance_market_id, 'yes', 95, attackAmount);
    const filled = result.data?.filled || 0;
    totalFilled += filled;
    
    if (filled === 0) {
      consecutiveZeros++;
    } else {
      consecutiveZeros = 0;
    }
    
    // Safety limit
    if (attacks > 200) break;
  }
  
  const exposure = db.prepare('SELECT * FROM bot_exposure WHERE id = ?').get('default');
  
  return { 
    filled: totalFilled, 
    attacks, 
    exposure: exposure?.total_at_risk || 0 
  };
}

async function runAllTests() {
  console.log('═'.repeat(70));
  console.log('🧪 100 SEPARATE TEST RUNS');
  console.log('═'.repeat(70));
  console.log('');
  console.log('📋 Configuration (per test):');
  console.log(`   Markets:        ${NUM_MARKETS}`);
  console.log(`   Liquidity:      ${fmt(TOTAL_LIQUIDITY)} sats`);
  console.log(`   Max loss:       ${fmt(MAX_LOSS)} sats`);
  console.log(`   Attack range:   ${fmt(MIN_ATTACK)} - ${fmt(MAX_ATTACK)} sats`);
  console.log('');
  
  const db = new Database(DB_PATH);
  
  try {
    const allMarkets = await getMarkets();
    if (!allMarkets || allMarkets.length < NUM_MARKETS) {
      console.error(`Need at least ${NUM_MARKETS} markets, have ${allMarkets?.length || 0}`);
      return;
    }
    const testMarkets = allMarkets.slice(0, NUM_MARKETS);
    
    console.log('═'.repeat(70));
    console.log('Test#  | Total Filled    | Attacks | Exposure        | % of Max');
    console.log('─'.repeat(70));
    
    const results = [];
    
    for (let i = 1; i <= NUM_TESTS; i++) {
      const result = await runSingleTest(db, i, testMarkets);
      results.push(result);
      
      const pctMax = ((result.exposure / MAX_LOSS) * 100).toFixed(1);
      console.log(`  ${String(i).padStart(3)}  | ${fmt(result.filled).padStart(15)} | ${String(result.attacks).padStart(7)} | ${fmt(result.exposure).padStart(15)} | ${pctMax.padStart(5)}%`);
    }
    
    // Summary statistics
    console.log('');
    console.log('═'.repeat(70));
    console.log('📊 SUMMARY STATISTICS');
    console.log('═'.repeat(70));
    
    const filled = results.map(r => r.filled);
    const exposures = results.map(r => r.exposure);
    
    const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const min = arr => Math.min(...arr);
    const max = arr => Math.max(...arr);
    const stddev = arr => {
      const m = avg(arr);
      return Math.sqrt(arr.reduce((acc, val) => acc + Math.pow(val - m, 2), 0) / arr.length);
    };
    
    console.log('');
    console.log('   FILLED (amount attackers got):');
    console.log(`      Min:    ${fmt(min(filled))} sats`);
    console.log(`      Max:    ${fmt(max(filled))} sats`);
    console.log(`      Avg:    ${fmt(Math.round(avg(filled)))} sats`);
    console.log(`      StdDev: ${fmt(Math.round(stddev(filled)))} sats`);
    
    console.log('');
    console.log('   EXPOSURE (bot at-risk):');
    console.log(`      Min:    ${fmt(min(exposures))} sats (${((min(exposures)/MAX_LOSS)*100).toFixed(1)}% of max)`);
    console.log(`      Max:    ${fmt(max(exposures))} sats (${((max(exposures)/MAX_LOSS)*100).toFixed(1)}% of max)`);
    console.log(`      Avg:    ${fmt(Math.round(avg(exposures)))} sats (${((avg(exposures)/MAX_LOSS)*100).toFixed(1)}% of max)`);
    
    // Distribution
    console.log('');
    console.log('   EXPOSURE DISTRIBUTION:');
    const brackets = [[0, 50], [50, 100], [100, 150], [150, 200], [200, 250]];
    for (const [lo, hi] of brackets) {
      const count = exposures.filter(e => e >= lo * 1000 && e < hi * 1000).length;
      const bar = '█'.repeat(Math.min(40, count));
      console.log(`      ${fmt(lo*1000).padStart(7)}-${fmt(hi*1000).padStart(7)}: ${String(count).padStart(3)} ${bar}`);
    }
    
    // Verify max loss protection
    const overMax = exposures.filter(e => e > MAX_LOSS).length;
    console.log('');
    console.log('═'.repeat(70));
    if (overMax === 0) {
      console.log('✅ MAX LOSS PROTECTION: ALL 100 TESTS PASSED');
      console.log(`   No test exceeded max_loss of ${fmt(MAX_LOSS)} sats`);
    } else {
      console.log(`❌ MAX LOSS PROTECTION: ${overMax} TESTS EXCEEDED MAX LOSS`);
    }
    console.log('═'.repeat(70));
    
  } finally {
    db.close();
  }
}

runAllTests().catch(console.error);
