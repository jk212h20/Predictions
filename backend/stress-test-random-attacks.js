#!/usr/bin/env node
/**
 * RANDOM ATTACK STRESS TEST
 * 
 * Configuration:
 * - Total liquidity: 1,000,000 sats
 * - Max loss: 100,000 sats
 * - Markets: 10
 * - Attacks: 100 (random amounts, random markets)
 * 
 * Reports booked amount for each attack until liquidity exhausted.
 */

const http = require('http');
const Database = require('better-sqlite3');

const BASE_URL = process.env.API_URL || 'http://localhost:3001';
const DB_PATH = process.env.DB_PATH || './predictions.db';

const TOTAL_LIQUIDITY = 1000000;  // 1M sats displayed
const MAX_LOSS = 100000;          // 100k max loss
const NUM_MARKETS = 10;
const NUM_ATTACKS = 100;
const MIN_ATTACK = 1000;          // Min attack: 1k sats
const MAX_ATTACK = 50000;         // Max attack: 50k sats

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
  const email = `random-${Date.now()}-${suffix}@test.com`;
  const result = await makeRequest('POST', '/api/auth/demo-login', { email, username: `rnd${suffix}` });
  return result.data;
}

async function getMarkets() {
  const result = await makeRequest('GET', '/api/grandmasters');
  return result.data;
}

async function placeOrder(token, marketId, side, priceSats, amountSats) {
  return await makeRequest('POST', '/api/orders', {
    market_id: marketId, side, price_sats: priceSats, amount_sats: amountSats
  }, token);
}

function fmt(sats) { return (sats || 0).toLocaleString(); }

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function runRandomAttackTest() {
  console.log('═'.repeat(70));
  console.log('🎲 RANDOM ATTACK STRESS TEST');
  console.log('═'.repeat(70));
  console.log('');
  console.log('📋 Configuration:');
  console.log(`   Total liquidity:    ${fmt(TOTAL_LIQUIDITY)} sats`);
  console.log(`   Max loss:           ${fmt(MAX_LOSS)} sats`);
  console.log(`   Markets:            ${NUM_MARKETS}`);
  console.log(`   Planned attacks:    ${NUM_ATTACKS}`);
  console.log(`   Attack range:       ${fmt(MIN_ATTACK)} - ${fmt(MAX_ATTACK)} sats`);
  console.log('');
  
  const db = new Database(DB_PATH);
  
  try {
    // Clear all orders
    db.prepare(`UPDATE orders SET status = 'cancelled' WHERE status IN ('open','partial')`).run();
    db.prepare(`INSERT OR REPLACE INTO bot_exposure (id, total_at_risk, current_tier) VALUES ('default', 0, 0)`).run();
    
    // Create bot user with enough balance
    const botAuth = await createUser('bot');
    if (!botAuth.token) {
      console.error('Failed to create bot user');
      return;
    }
    
    // Give bot enough balance
    db.prepare('UPDATE users SET balance_sats = ? WHERE id = ?').run(TOTAL_LIQUIDITY * 2, botAuth.user.id);
    
    // Configure bot (10% threshold for more granular pullback)
    db.prepare(`
      UPDATE bot_config 
      SET bot_user_id = ?, max_acceptable_loss = ?, total_liquidity = ?, threshold_percent = 10, global_multiplier = 1, is_active = 1 
      WHERE id = 'default'
    `).run(botAuth.user.id, MAX_LOSS, TOTAL_LIQUIDITY);
    
    console.log(`   Bot user: ${botAuth.user.id}`);
    console.log('');
    
    // Get markets
    const allMarkets = await getMarkets();
    const testMarkets = allMarkets.slice(0, NUM_MARKETS);
    
    console.log('📊 Markets:');
    testMarkets.forEach((m, i) => {
      console.log(`   ${i+1}. ${m.name}`);
    });
    console.log('');
    
    // Bot deploys liquidity to all markets (equal split)
    const perMarket = Math.floor(TOTAL_LIQUIDITY / NUM_MARKETS);
    console.log(`🚀 Bot deploying ${fmt(perMarket)} sats per market...`);
    
    for (const market of testMarkets) {
      // Deploy at various price points (5%, 10%, 15%, 20%, 25%, 30%)
      const prices = [5, 10, 15, 20, 25, 30];
      const perPrice = Math.floor(perMarket / prices.length);
      
      for (const price of prices) {
        await placeOrder(botAuth.token, market.attendance_market_id, 'no', price, perPrice);
      }
    }
    
    console.log('   Done!\n');
    
    // Run random attacks
    console.log('═'.repeat(70));
    console.log('⚔️  ATTACK LOG');
    console.log('═'.repeat(70));
    console.log('  #  | Market              | Attempted | Filled    | Exposure  | Tier');
    console.log('─'.repeat(70));
    
    const results = [];
    let totalFilled = 0;
    let attackNum = 0;
    let consecutiveZeros = 0;
    
    for (let i = 0; i < NUM_ATTACKS; i++) {
      attackNum++;
      
      // Random market
      const marketIdx = randomInt(0, NUM_MARKETS - 1);
      const market = testMarkets[marketIdx];
      
      // Random attack amount
      const attackAmount = randomInt(MIN_ATTACK, MAX_ATTACK);
      
      // Create attacker
      const attackerAuth = await createUser(`atk${i}`);
      if (!attackerAuth.token) continue;
      
      // Place YES order at price that matches bot's NO orders
      // Bot has NO at 5-30%, so YES@95 will match all (100-95=5 <= all bot's NO prices)
      const result = await placeOrder(attackerAuth.token, market.attendance_market_id, 'yes', 95, attackAmount);
      
      const filled = result.data?.filled || 0;
      const exposure = db.prepare('SELECT * FROM bot_exposure WHERE id = ?').get('default');
      
      const shortName = market.name.substring(0, 17).padEnd(17);
      console.log(`  ${String(attackNum).padStart(2)} | ${shortName} | ${fmt(attackAmount).padStart(9)} | ${fmt(filled).padStart(9)} | ${fmt(exposure?.total_at_risk || 0).padStart(9)} | ${exposure?.current_tier || 0}`);
      
      results.push({
        num: attackNum,
        market: market.name,
        attempted: attackAmount,
        filled,
        exposure: exposure?.total_at_risk || 0,
        tier: exposure?.current_tier || 0
      });
      
      totalFilled += filled;
      
      // Track consecutive zeros (but don't exit - run all 100)
      if (filled === 0) {
        consecutiveZeros++;
      } else {
        consecutiveZeros = 0;
      }
    }
    
    // Summary
    console.log('');
    console.log('═'.repeat(70));
    console.log('📊 SUMMARY');
    console.log('═'.repeat(70));
    
    const totalAttempted = results.reduce((s, r) => s + r.attempted, 0);
    const filledAttacks = results.filter(r => r.filled > 0).length;
    const zeroFills = results.filter(r => r.filled === 0).length;
    const finalExposure = results[results.length - 1]?.exposure || 0;
    
    console.log(`   Total attacks:         ${attackNum}`);
    console.log(`   Attacks with fills:    ${filledAttacks}`);
    console.log(`   Zero fills:            ${zeroFills}`);
    console.log(`   Total attempted:       ${fmt(totalAttempted)} sats`);
    console.log(`   Total filled:          ${fmt(totalFilled)} sats`);
    console.log(`   Fill rate:             ${((totalFilled / totalAttempted) * 100).toFixed(1)}%`);
    console.log(`   Final exposure:        ${fmt(finalExposure)} sats`);
    console.log(`   Max loss limit:        ${fmt(MAX_LOSS)} sats`);
    console.log(`   Exposure vs max:       ${((finalExposure / MAX_LOSS) * 100).toFixed(1)}%`);
    console.log('');
    
    // Show fill distribution
    console.log('📈 FILL DISTRIBUTION:');
    const brackets = [0, 1000, 5000, 10000, 20000, 50000];
    for (let i = 0; i < brackets.length - 1; i++) {
      const count = results.filter(r => r.filled >= brackets[i] && r.filled < brackets[i+1]).length;
      const bar = '█'.repeat(Math.min(40, count));
      console.log(`   ${fmt(brackets[i]).padStart(6)}-${fmt(brackets[i+1]).padStart(6)}: ${String(count).padStart(3)} ${bar}`);
    }
    const over50k = results.filter(r => r.filled >= 50000).length;
    console.log(`   ${fmt(50000).padStart(6)}+      : ${String(over50k).padStart(3)} ${'█'.repeat(Math.min(40, over50k))}`);
    
    console.log('');
    console.log('═'.repeat(70));
    
    // Verify max loss protection
    if (finalExposure <= MAX_LOSS) {
      console.log('✅ MAX LOSS PROTECTION: VERIFIED');
      console.log(`   Exposure (${fmt(finalExposure)}) ≤ Max Loss (${fmt(MAX_LOSS)})`);
    } else {
      console.log('❌ MAX LOSS PROTECTION: FAILED');
      console.log(`   Exposure (${fmt(finalExposure)}) > Max Loss (${fmt(MAX_LOSS)})`);
    }
    
    console.log('═'.repeat(70));
    
  } finally {
    db.close();
  }
}

runRandomAttackTest().catch(console.error);
