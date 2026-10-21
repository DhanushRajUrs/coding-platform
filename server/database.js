const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const dataDirectory =
  process.env.DATA_DIR || path.join(__dirname, 'data');

fs.mkdirSync(dataDirectory, { recursive: true });

const databasePath = path.join(dataDirectory, 'leaderboard.sqlite');
const db = new sqlite3.Database(databasePath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant_name TEXT NOT NULL,
      problem_id TEXT NOT NULL,
      language TEXT NOT NULL,
      score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

module.exports = db;
