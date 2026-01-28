/**
 * Seed database with top 100 GMs and create initial markets
 * Data based on FIDE ratings (approximate as of late 2025)
 */

const db = require('./database');
const { v4: uuidv4 } = require('uuid');

// Top 100 Grandmasters (FIDE classical ratings, approximate)
const TOP_GMS = [
  { name: 'Magnus Carlsen', fide_id: '1503014', rating: 2830, country: 'NOR' },
  { name: 'Fabiano Caruana', fide_id: '2020009', rating: 2805, country: 'USA' },
  { name: 'Hikaru Nakamura', fide_id: '2016192', rating: 2802, country: 'USA' },
  { name: 'Ding Liren', fide_id: '8603677', rating: 2780, country: 'CHN' },
  { name: 'Alireza Firouzja', fide_id: '12573981', rating: 2777, country: 'FRA' },
  { name: 'Ian Nepomniachtchi', fide_id: '4168119', rating: 2771, country: 'RUS' },
  { name: 'Gukesh Dommaraju', fide_id: '46616543', rating: 2770, country: 'IND' },
  { name: 'Wesley So', fide_id: '5202213', rating: 2760, country: 'USA' },
  { name: 'Anish Giri', fide_id: '24116068', rating: 2755, country: 'NED' },
  { name: 'Viswanathan Anand', fide_id: '5000017', rating: 2751, country: 'IND' },
  { name: 'Levon Aronian', fide_id: '13300474', rating: 2750, country: 'USA' },
  { name: 'Maxime Vachier-Lagrave', fide_id: '623539', rating: 2748, country: 'FRA' },
  { name: 'Richard Rapport', fide_id: '738590', rating: 2745, country: 'ROU' },
  { name: 'Sergey Karjakin', fide_id: '14109603', rating: 2743, country: 'RUS' },
  { name: 'Shakhriyar Mamedyarov', fide_id: '13401319', rating: 2740, country: 'AZE' },
  { name: 'Teimour Radjabov', fide_id: '13400924', rating: 2738, country: 'AZE' },
  { name: 'Jan-Krzysztof Duda', fide_id: '1170546', rating: 2735, country: 'POL' },
  { name: 'Nodirbek Abdusattorov', fide_id: '14204118', rating: 2733, country: 'UZB' },
  { name: 'Praggnanandhaa Rameshbabu', fide_id: '25059530', rating: 2730, country: 'IND' },
  { name: 'Vincent Keymer', fide_id: '12940690', rating: 2728, country: 'GER' },
  { name: 'Leinier Dominguez', fide_id: '3503240', rating: 2725, country: 'USA' },
  { name: 'Santosh Gujrathi Vidit', fide_id: '5029465', rating: 2723, country: 'IND' },
  { name: 'Yu Yangyi', fide_id: '8603405', rating: 2720, country: 'CHN' },
  { name: 'Pentala Harikrishna', fide_id: '5007003', rating: 2718, country: 'IND' },
  { name: 'Wei Yi', fide_id: '8603820', rating: 2715, country: 'CHN' },
  { name: 'Alexander Grischuk', fide_id: '4126025', rating: 2713, country: 'RUS' },
  { name: 'Sam Shankland', fide_id: '2004887', rating: 2710, country: 'USA' },
  { name: 'Nijat Abasov', fide_id: '13402960', rating: 2708, country: 'AZE' },
  { name: 'Arjun Erigaisi', fide_id: '35009192', rating: 2706, country: 'IND' },
  { name: 'Daniil Dubov', fide_id: '24126055', rating: 2704, country: 'RUS' },
  { name: 'Vladislav Artemiev', fide_id: '24101605', rating: 2702, country: 'RUS' },
  { name: 'Andrey Esipenko', fide_id: '24175439', rating: 2700, country: 'RUS' },
  { name: 'Dmitry Andreikin', fide_id: '4158814', rating: 2698, country: 'RUS' },
  { name: 'Boris Gelfand', fide_id: '2805677', rating: 2696, country: 'ISR' },
  { name: 'Radoslaw Wojtaszek', fide_id: '1118358', rating: 2694, country: 'POL' },
  { name: 'Peter Svidler', fide_id: '4102142', rating: 2692, country: 'RUS' },
  { name: 'Vassily Ivanchuk', fide_id: '14100010', rating: 2690, country: 'UKR' },
  { name: 'Etienne Bacrot', fide_id: '605506', rating: 2688, country: 'FRA' },
  { name: 'David Navara', fide_id: '309095', rating: 2686, country: 'CZE' },
  { name: 'Le Quang Liem', fide_id: '12401137', rating: 2684, country: 'VIE' },
  { name: 'Wang Hao', fide_id: '8602883', rating: 2682, country: 'CHN' },
  { name: 'Parham Maghsoodloo', fide_id: '12539929', rating: 2680, country: 'IRI' },
  { name: 'Jeffery Xiong', fide_id: '2047640', rating: 2678, country: 'USA' },
  { name: 'Nikita Vitiugov', fide_id: '4152956', rating: 2676, country: 'RUS' },
  { name: 'Michael Adams', fide_id: '400041', rating: 2674, country: 'ENG' },
  { name: 'Francisco Vallejo Pons', fide_id: '2205530', rating: 2672, country: 'ESP' },
  { name: 'Alexei Shirov', fide_id: '2209390', rating: 2670, country: 'ESP' },
  { name: 'Maxim Matlakov', fide_id: '4168003', rating: 2668, country: 'RUS' },
  { name: 'Baadur Jobava', fide_id: '13601520', rating: 2666, country: 'GEO' },
  { name: 'Aleksandr Rakhmanov', fide_id: '4147235', rating: 2664, country: 'RUS' },
  { name: 'Samuel Sevian', fide_id: '2041413', rating: 2662, country: 'USA' },
  { name: 'Kirill Alekseenko', fide_id: '4135539', rating: 2660, country: 'RUS' },
  { name: 'Hans Niemann', fide_id: '2093596', rating: 2658, country: 'USA' },
  { name: 'Ivan Saric', fide_id: '14508117', rating: 2656, country: 'CRO' },
  { name: 'Jorden van Foreest', fide_id: '1039784', rating: 2654, country: 'NED' },
  { name: 'Amin Tabatabaei', fide_id: '12528200', rating: 2652, country: 'IRI' },
  { name: 'Surya Shekhar Ganguly', fide_id: '5003261', rating: 2650, country: 'IND' },
  { name: 'Alexandr Predke', fide_id: '24156493', rating: 2648, country: 'RUS' },
  { name: 'Grigoriy Oparin', fide_id: '24125890', rating: 2646, country: 'USA' },
  { name: 'Sanan Sjugirov', fide_id: '4147952', rating: 2644, country: 'RUS' },
  { name: 'Matthias Bluebaum', fide_id: '24651516', rating: 2642, country: 'GER' },
  { name: 'Rinat Jumabayev', fide_id: '13700316', rating: 2640, country: 'KAZ' },
  { name: 'Nihal Sarin', fide_id: '25092340', rating: 2638, country: 'IND' },
  { name: 'Alexandros Papaioannou', fide_id: '25097326', rating: 2636, country: 'GRE' },
  { name: 'Abhimanyu Puranik', fide_id: '25019023', rating: 2634, country: 'IND' },
  { name: 'David Anton', fide_id: '2285525', rating: 2632, country: 'ESP' },
  { name: 'Jaime Santos Latasa', fide_id: '2236117', rating: 2630, country: 'ESP' },
  { name: 'Rasmus Svane', fide_id: '4657101', rating: 2628, country: 'GER' },
  { name: 'Gata Kamsky', fide_id: '2000024', rating: 2626, country: 'USA' },
  { name: 'Nils Grandelius', fide_id: '1710400', rating: 2624, country: 'SWE' },
  { name: 'Rauf Mamedov', fide_id: '13401653', rating: 2622, country: 'AZE' },
  { name: 'Arkadij Naiditsch', fide_id: '4650891', rating: 2620, country: 'AZE' },
  { name: 'Evgeny Tomashevsky', fide_id: '4147502', rating: 2618, country: 'RUS' },
  { name: 'David Howell', fide_id: '410608', rating: 2616, country: 'ENG' },
  { name: 'Pavel Eljanov', fide_id: '14105730', rating: 2614, country: 'UKR' },
  { name: 'Gabor Papp', fide_id: '716227', rating: 2612, country: 'HUN' },
  { name: 'Ivan Cheparinov', fide_id: '2905540', rating: 2610, country: 'BUL' },
  { name: 'Sethuraman Panayappan', fide_id: '5018471', rating: 2608, country: 'IND' },
  { name: 'Krishnan Sasikiran', fide_id: '5004985', rating: 2606, country: 'IND' },
  { name: 'Luke McShane', fide_id: '404853', rating: 2604, country: 'ENG' },
  { name: 'Erwin lAmi', fide_id: '1007580', rating: 2602, country: 'NED' },
  { name: 'Yuriy Kuzubov', fide_id: '14113597', rating: 2600, country: 'UKR' },
  { name: 'Viktor Laznicka', fide_id: '316385', rating: 2598, country: 'CZE' },
  { name: 'Daniel Fridman', fide_id: '4202066', rating: 2596, country: 'GER' },
  { name: 'Yannick Gozzoli', fide_id: '605719', rating: 2594, country: 'FRA' },
  { name: 'Evgeny Postny', fide_id: '2811502', rating: 2592, country: 'ISR' },
  { name: 'Ruslan Ponomariov', fide_id: '14103320', rating: 2590, country: 'UKR' },
  { name: 'Bu Xiangzhi', fide_id: '8601445', rating: 2588, country: 'CHN' },
  { name: 'Aleksey Dreev', fide_id: '4100018', rating: 2586, country: 'RUS' },
  { name: 'Emil Sutovsky', fide_id: '2802007', rating: 2584, country: 'ISR' },
  { name: 'Alexander Motylev', fide_id: '4121970', rating: 2582, country: 'RUS' },
  { name: 'Abhijeet Gupta', fide_id: '5010608', rating: 2580, country: 'IND' },
  { name: 'Ernesto Inarkiev', fide_id: '4162722', rating: 2578, country: 'RUS' },
  { name: 'Vladimir Fedoseev', fide_id: '24130737', rating: 2576, country: 'RUS' },
  { name: 'Ray Robson', fide_id: '2029069', rating: 2574, country: 'USA' },
  { name: 'Zoltan Almasi', fide_id: '703303', rating: 2572, country: 'HUN' },
  { name: 'Alexander Areshchenko', fide_id: '14107791', rating: 2570, country: 'UKR' },
  { name: 'Romain Edouard', fide_id: '614203', rating: 2568, country: 'FRA' },
  { name: 'Nguyen Ngoc Truong Son', fide_id: '12401293', rating: 2566, country: 'VIE' },
];

function seed() {
  console.log('Seeding database...');
  
  const insertGM = db.prepare(`
    INSERT OR IGNORE INTO grandmasters (id, name, fide_id, fide_rating, country, title)
    VALUES (?, ?, ?, ?, ?, 'GM')
  `);
  
  const insertMarket = db.prepare(`
    INSERT OR IGNORE INTO markets (id, type, grandmaster_id, title, description)
    VALUES (?, ?, ?, ?, ?)
  `);

  // Begin transaction
  const seedAll = db.transaction(() => {
    // Insert all GMs and create markets for each
    for (const gm of TOP_GMS) {
      const gmId = uuidv4();
      insertGM.run(gmId, gm.name, gm.fide_id, gm.rating, gm.country);
      
      // Create attendance market
      const attendId = uuidv4();
      insertMarket.run(
        attendId,
        'attendance',
        gmId,
        `Will ${gm.name} attend?`,
        `Market resolves YES if ${gm.name} officially registers and attends the Bitcoin Chess 960 Championship in Prospera, March 16-22, 2026.`
      );
      
      // Create winner market
      const winnerId = uuidv4();
      insertMarket.run(
        winnerId,
        'winner',
        gmId,
        `Will ${gm.name} win?`,
        `Market resolves YES if ${gm.name} wins the Bitcoin Chess 960 Championship in Prospera, March 16-22, 2026.`
      );
    }
    
    // Create the main "Will event happen?" market
    const eventMarketId = uuidv4();
    insertMarket.run(
      eventMarketId,
      'event',
      null,
      'Will the Bitcoin Chess 960 Championship happen?',
      'Market resolves YES if the Bitcoin Chess 960 Championship takes place in Prospera between March 16-22, 2026 with at least one official game played.'
    );
    
    // Create a demo admin user
    const adminId = uuidv4();
    db.prepare(`
      INSERT OR IGNORE INTO users (id, email, username, balance_sats, is_admin)
      VALUES (?, ?, ?, ?, 1)
    `).run(adminId, 'admin@chess960.btc', 'Admin', 10000000); // 10M sats for liquidity
    
    console.log(`Seeded ${TOP_GMS.length} grandmasters`);
    console.log(`Created ${TOP_GMS.length * 2 + 1} markets`);
    console.log('Created admin user');
  });
  
  seedAll();
  console.log('Database seeding complete!');
}

// Run if called directly
if (require.main === module) {
  seed();
}

module.exports = { seed, TOP_GMS };
