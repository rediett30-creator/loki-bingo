const { Pool } = require('pg');

// Get database URL from Railway
const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  console.error('❌ DATABASE_URL is not set!');
} else {
  console.log('✅ DATABASE_URL found');
}

// Create connection to database - SIMPLE VERSION THAT WORKS
const pool = new Pool({
  connectionString: dbUrl,
  ssl: {
    rejectUnauthorized: false // This is important for Railway
  }
});

// Test database connection
pool.connect((err) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
    console.log('⚠️ Continuing without database - balances will reset on restart');
  } else {
    console.log('✅ Database connected successfully!');
  }
});

// Create all tables
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        telegram_id TEXT PRIMARY KEY,
        username TEXT,
        balance INTEGER DEFAULT 1250,
        games_played INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        total_won INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        id SERIAL PRIMARY KEY,
        game_round INTEGER,
        prize_pool INTEGER,
        commission INTEGER,
        winner_id TEXT,
        winner_name TEXT,
        winning_pattern TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS commissions (
        id SERIAL PRIMARY KEY,
        game_id INTEGER REFERENCES games(id),
        amount INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('✅ Database tables ready');
  } catch (error) {
    console.error('❌ Error creating tables:', error.message);
  }
}

// Call initialization
initializeDatabase();

// ===== PLAYER FUNCTIONS =====
async function getPlayerBalance(telegramId, username) {
  try {
    const result = await pool.query(
      'SELECT * FROM players WHERE telegram_id = $1',
      [telegramId]
    );
    
    if (result.rows.length > 0) {
      await pool.query(
        'UPDATE players SET last_seen = CURRENT_TIMESTAMP, username = $2 WHERE telegram_id = $1',
        [telegramId, username]
      );
      return result.rows[0].balance;
    } else {
      await pool.query(
        'INSERT INTO players (telegram_id, username, balance) VALUES ($1, $2, 1250)',
        [telegramId, username]
      );
      console.log(`👤 New player created: ${username}`);
      return 1250;
    }
  } catch (error) {
    console.error('❌ Error getting player balance:', error.message);
    return 1250;
  }
}

async function deductBalance(telegramId, amount) {
  try {
    const result = await pool.query(
      'UPDATE players SET balance = balance - $2 WHERE telegram_id = $1 AND balance >= $2 RETURNING balance',
      [telegramId, amount]
    );
    
    if (result.rows.length > 0) {
      return { success: true, newBalance: result.rows[0].balance };
    } else {
      return { success: false, message: 'Insufficient balance' };
    }
  } catch (error) {
    console.error('❌ Error deducting balance:', error.message);
    return { success: false, message: 'Database error' };
  }
}

async function addBalance(telegramId, amount) {
  try {
    const result = await pool.query(
      'UPDATE players SET balance = balance + $2 WHERE telegram_id = $1 RETURNING balance',
      [telegramId, amount]
    );
    return { success: true, newBalance: result.rows[0].balance };
  } catch (error) {
    console.error('❌ Error adding balance:', error.message);
    return { success: false };
  }
}

async function saveGameResult(gameRound, prizePool, winnerId, winnerName, winningPattern) {
  try {
    const commission = Math.floor(prizePool * 0.2);
    const winnerPrize = prizePool - commission;
    
    const gameResult = await pool.query(
      `INSERT INTO games (game_round, prize_pool, commission, winner_id, winner_name, winning_pattern) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [gameRound, prizePool, commission, winnerId, winnerName, winningPattern]
    );
    
    const gameId = gameResult.rows[0].id;
    
    await pool.query(
      'INSERT INTO commissions (game_id, amount) VALUES ($1, $2)',
      [gameId, commission]
    );
    
    await pool.query(
      'UPDATE players SET games_played = games_played + 1, wins = wins + 1, total_won = total_won + $2 WHERE telegram_id = $1',
      [winnerId, winnerPrize]
    );
    
    console.log(`💰 Game saved! Commission: ${commission} (20% of ${prizePool})`);
    return { success: true, commission, winnerPrize };
  } catch (error) {
    console.error('❌ Error saving game:', error.message);
    return { success: false };
  }
}

async function getTotalCommissions() {
  try {
    const result = await pool.query(
      'SELECT SUM(amount) as total FROM commissions'
    );
    return result.rows[0].total || 0;
  } catch (error) {
    console.error('❌ Error getting commissions:', error.message);
    return 0;
  }
}

async function getRecentGames(limit = 5) {
  try {
    const result = await pool.query(
      `SELECT * FROM games ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  } catch (error) {
    console.error('❌ Error getting recent games:', error.message);
    return [];
  }
}

module.exports = {
  getPlayerBalance,
  deductBalance,
  addBalance,
  saveGameResult,
  getTotalCommissions,
  getRecentGames,
  pool
};