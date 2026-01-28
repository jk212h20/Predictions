/**
 * Seed database with players from attendance_likelihood.csv
 * 
 * Features:
 * - Reads the CSV from research/attendance_likelihood.csv
 * - Filters out retired/banned players (tier X or D with RETIRED flag)
 * - Only adds missing markets (doesn't recreate existing ones)
 * - Assigns tiers based on likelihood score
 * - Updates existing grandmaster records with tier info
 * 
 * Usage: node backend/seed-players.js
 */

const db = require('./database');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// Tier mapping based on score ranges
function scoreToBracket(score) {
  if (score >= 70) return 'S';      // Most Likely
  if (score >= 60) return 'A+';     // Very Likely
  if (score >= 50) return 'A';      // Likely
  if (score >= 40) return 'B+';     // Above Average
  if (score >= 25) return 'B';      // Average
  if (score >= 0) return 'C';       // Below Average
  return 'D';                        // Unlikely
}

// Parse CSV - handles quoted fields with commas
function parseCSV(content) {
  const lines = content.split('\n');
  const headers = parseCSVLine(lines[0]);
  const data = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const values = parseCSVLine(line);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || '';
    });
    data.push(row);
  }
  
  return data;
}

// Parse a single CSV line, handling quoted fields
function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  
  return values;
}

// Parse player name from "Last, First" format
function parseName(nameStr) {
  // Remove quotes if present
  nameStr = nameStr.replace(/^"|"$/g, '');
  
  // Handle "Last, First" format
  if (nameStr.includes(',')) {
    const parts = nameStr.split(',').map(s => s.trim());
    if (parts.length === 2) {
      return `${parts[1]} ${parts[0]}`;
    }
  }
  
  return nameStr;
}

// Check if player should be excluded (retired/banned)
function shouldExclude(row) {
  const tier = row.Tier;
  const keyFactors = row['Key Factors'] || '';
  
  // Exclude tier X (cannot attend)
  if (tier === 'X') return true;
  
  // Exclude players with RETIRED flag
  if (keyFactors.includes('❌ RETIRED')) return true;
  
  // Exclude tier D with negative scores (likely retired/banned)
  if (tier === 'D' && parseInt(row.Score) < -30) return true;
  
  return false;
}

function seed() {
  console.log('🎯 Seeding players from attendance_likelihood.csv...\n');
  
  // Read the CSV file
  const csvPath = path.join(__dirname, '..', 'research', 'attendance_likelihood.csv');
  if (!fs.existsSync(csvPath)) {
    console.error('❌ CSV file not found at:', csvPath);
    process.exit(1);
  }
  
  const csvContent = fs.readFileSync(csvPath, 'utf-8');
  const players = parseCSV(csvContent);
  
  console.log(`📋 Found ${players.length} players in CSV\n`);
  
  // Prepare statements
  const findGMByName = db.prepare(`
    SELECT id, name FROM grandmasters WHERE name LIKE ? OR name LIKE ?
  `);
  
  const insertGM = db.prepare(`
    INSERT INTO grandmasters (id, name, fide_rating, country, tier, likelihood_score, key_factors)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  const updateGM = db.prepare(`
    UPDATE grandmasters 
    SET tier = ?, likelihood_score = ?, key_factors = ?, fide_rating = COALESCE(?, fide_rating)
    WHERE id = ?
  `);
  
  const findAttendanceMarket = db.prepare(`
    SELECT id FROM markets WHERE grandmaster_id = ? AND type = 'attendance'
  `);
  
  const findWinnerMarket = db.prepare(`
    SELECT id FROM markets WHERE grandmaster_id = ? AND type = 'winner'
  `);
  
  const insertMarket = db.prepare(`
    INSERT INTO markets (id, type, grandmaster_id, title, description)
    VALUES (?, ?, ?, ?, ?)
  `);
  
  // Stats
  let excluded = 0;
  let gmCreated = 0;
  let gmUpdated = 0;
  let attendanceCreated = 0;
  let winnerCreated = 0;
  let skipped = 0;
  
  // Begin transaction
  const seedAll = db.transaction(() => {
    for (const row of players) {
      const rawName = row.Name;
      const score = parseInt(row.Score) || 0;
      const rating = parseInt(row.Rating) || null;
      const country = row.Federation || '';
      const keyFactors = row['Key Factors'] || '';
      
      // Skip excluded players
      if (shouldExclude(row)) {
        console.log(`  ⏭️  Skipping (excluded): ${rawName}`);
        excluded++;
        continue;
      }
      
      const name = parseName(rawName);
      const tier = scoreToBracket(score);
      
      // Try to find existing GM by name (fuzzy match)
      let gm = findGMByName.get(`%${name}%`, `%${rawName}%`);
      
      if (gm) {
        // Update existing GM with tier info
        updateGM.run(tier, score, keyFactors, rating, gm.id);
        gmUpdated++;
        console.log(`  ✏️  Updated: ${name} (Tier ${tier}, Score ${score})`);
      } else {
        // Create new GM
        const gmId = uuidv4();
        insertGM.run(gmId, name, rating, country, tier, score, keyFactors);
        gm = { id: gmId, name };
        gmCreated++;
        console.log(`  ✨ Created GM: ${name} (${country}, Rating ${rating}, Tier ${tier})`);
      }
      
      // Check/create attendance market
      const existingAttendance = findAttendanceMarket.get(gm.id);
      if (!existingAttendance) {
        const marketId = uuidv4();
        insertMarket.run(
          marketId,
          'attendance',
          gm.id,
          `Will ${name} attend?`,
          `Market resolves YES if ${name} officially registers and attends the Bitcoin Chess 960 Championship in Prospera, March 16-22, 2026.`
        );
        attendanceCreated++;
      } else {
        skipped++;
      }
      
      // Check/create winner market
      const existingWinner = findWinnerMarket.get(gm.id);
      if (!existingWinner) {
        const marketId = uuidv4();
        insertMarket.run(
          marketId,
          'winner',
          gm.id,
          `Will ${name} win?`,
          `Market resolves YES if ${name} wins the Bitcoin Chess 960 Championship in Prospera, March 16-22, 2026.`
        );
        winnerCreated++;
      } else {
        skipped++;
      }
    }
  });
  
  seedAll();
  
  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 SUMMARY');
  console.log('='.repeat(50));
  console.log(`  Players in CSV:       ${players.length}`);
  console.log(`  Excluded (retired):   ${excluded}`);
  console.log(`  GMs created:          ${gmCreated}`);
  console.log(`  GMs updated:          ${gmUpdated}`);
  console.log(`  Attendance markets:   ${attendanceCreated} created`);
  console.log(`  Winner markets:       ${winnerCreated} created`);
  console.log(`  Skipped (existing):   ${skipped}`);
  
  // Show tier distribution
  const tierCounts = db.prepare(`
    SELECT tier, COUNT(*) as count FROM grandmasters WHERE tier IS NOT NULL GROUP BY tier ORDER BY 
    CASE tier 
      WHEN 'S' THEN 1 
      WHEN 'A+' THEN 2 
      WHEN 'A' THEN 3 
      WHEN 'B+' THEN 4 
      WHEN 'B' THEN 5 
      WHEN 'C' THEN 6 
      WHEN 'D' THEN 7 
    END
  `).all();
  
  console.log('\n📈 TIER DISTRIBUTION');
  console.log('='.repeat(50));
  for (const t of tierCounts) {
    const bar = '█'.repeat(Math.min(t.count, 30));
    console.log(`  ${t.tier.padEnd(3)} ${bar} ${t.count}`);
  }
  
  console.log('\n✅ Done!');
}

// Run if called directly
if (require.main === module) {
  seed();
}

module.exports = { seed, scoreToBracket };
