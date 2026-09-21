/**
 * Database — Schema v2 (per brief Section 4)
 * 
 * 8 tabel:
 *   content, content_metric_snapshot, account_daily, comment,
 *   content_group, content_group_member, sync_run, token_state
 * 
 * Aturan ketat:
 *   - NULL ≠ 0. Metric yang belum tersedia disimpan NULL, ditampilkan sebagai "n/a".
 *   - Token TIDAK PERNAH dikembalikan via API.
 *   - Semua timestamp disimpan sebagai ISO 8601 UTC.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'asistent_creator.db');

// Pastikan direktori data ada
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');      // Concurrent reads
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    initSchema(db);
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    -- ──────────────────────────────────────────────────────────────────────────
    -- content: setiap konten yang pernah ditemukan di platform
    -- ──────────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS content (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      platform          TEXT    NOT NULL CHECK (platform IN ('instagram','threads','youtube','tiktok','facebook')),
      platform_id       TEXT    NOT NULL,         -- ID unik dari platform (video_id, media_id, dll)
      content_type      TEXT    NOT NULL,         -- 'VIDEO', 'REEL', 'IMAGE', 'CAROUSEL', 'TEXT', 'SHORT', 'THREAD', 'STORY'
      title             TEXT,                     -- Judul video (YT) atau caption awal (IG/Threads)
      title_override    TEXT,                     -- Label manual dari pemilik (tampil menggantikan title)
      caption           TEXT,                     -- Caption lengkap
      url               TEXT,                     -- URL permanen konten
      thumbnail_url     TEXT,
      duration_seconds  INTEGER,                  -- NULL untuk non-video
      published_at      TEXT    NOT NULL,         -- ISO 8601 UTC
      discovered_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      last_synced_at    TEXT,
      is_deleted        INTEGER NOT NULL DEFAULT 0,  -- 1 = sudah dihapus dari platform
      updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (platform, platform_id)
    );

    CREATE INDEX IF NOT EXISTS idx_content_platform ON content(platform);
    CREATE INDEX IF NOT EXISTS idx_content_published ON content(published_at DESC);

    -- ──────────────────────────────────────────────────────────────────────────
    -- content_metric_snapshot: snapshot metrik per konten
    -- Untuk IG/Threads: snapshot kumulatif (API tidak sediakan daily breakdown)
    -- Untuk YouTube: snapshot per sync run + Analytics daily rows
    -- ──────────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS content_metric_snapshot (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id        INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
      snapshot_date     TEXT    NOT NULL,         -- Tanggal snapshot (YYYY-MM-DD) — bukan datetime agar mudah di-query
      snapshot_at       TEXT    NOT NULL DEFAULT (datetime('now')),  -- Waktu persis snapshot
      
      -- Engagement universal
      views             INTEGER,                  -- NULL jika tidak tersedia di API
      likes             INTEGER,
      comments          INTEGER,
      shares            INTEGER,
      saves             INTEGER,                  -- Instagram "saved", YouTube "playlist adds"
      
      -- Jangkauan
      reach             INTEGER,                  -- Unique accounts yang melihat
      impressions       INTEGER,
      
      -- Threads-specific
      reposts           INTEGER,
      quotes            INTEGER,
      
      -- YouTube-specific
      estimated_minutes_watched INTEGER,
      average_view_duration     INTEGER,          -- dalam detik
      average_view_percentage   REAL,
      subscribers_gained        INTEGER,
      subscribers_lost          INTEGER,
      card_impressions          INTEGER,
      card_click_rate           REAL,
      
      -- Metadata
      source            TEXT NOT NULL DEFAULT 'sync',  -- 'sync' | 'backfill' | 'manual'
      
      UNIQUE (content_id, snapshot_date)          -- Satu snapshot per konten per hari
    );

    CREATE INDEX IF NOT EXISTS idx_snapshot_content ON content_metric_snapshot(content_id);
    CREATE INDEX IF NOT EXISTS idx_snapshot_date ON content_metric_snapshot(snapshot_date DESC);

    -- ──────────────────────────────────────────────────────────────────────────
    -- account_daily: metrik level akun per hari (bukan per konten)
    -- ──────────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS account_daily (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      platform          TEXT    NOT NULL CHECK (platform IN ('instagram','threads','youtube','tiktok','facebook')),
      date              TEXT    NOT NULL,         -- YYYY-MM-DD
      
      followers         INTEGER,
      following         INTEGER,
      total_views       INTEGER,
      total_reach       INTEGER,
      subscribers       INTEGER,                  -- YouTube
      
      synced_at         TEXT    NOT NULL DEFAULT (datetime('now')),
      
      UNIQUE (platform, date)
    );

    CREATE INDEX IF NOT EXISTS idx_account_daily_platform ON account_daily(platform, date DESC);

    -- ──────────────────────────────────────────────────────────────────────────
    -- comment: komentar pada konten
    -- ──────────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS comment (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id        INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
      platform_comment_id TEXT  NOT NULL,
      parent_comment_id   INTEGER REFERENCES comment(id),  -- untuk reply/thread
      author_name       TEXT,
      author_id         TEXT,
      text              TEXT    NOT NULL,
      like_count        INTEGER DEFAULT 0,
      published_at      TEXT    NOT NULL,
      fetched_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      
      UNIQUE (platform_comment_id)
    );

    CREATE INDEX IF NOT EXISTS idx_comment_content ON comment(content_id);
    CREATE INDEX IF NOT EXISTS idx_comment_published ON comment(published_at DESC);

    -- ──────────────────────────────────────────────────────────────────────────
    -- content_group: pengelompokan konten lintas platform
    -- ──────────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS content_group (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT    NOT NULL,
      description       TEXT,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS content_group_member (
      group_id          INTEGER NOT NULL REFERENCES content_group(id) ON DELETE CASCADE,
      content_id        INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
      added_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (group_id, content_id)
    );

    -- ──────────────────────────────────────────────────────────────────────────
    -- sync_run: log setiap kali sync engine berjalan
    -- ──────────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sync_run (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      platform          TEXT,                     -- NULL = semua platform
      trigger           TEXT    NOT NULL,         -- 'scheduled' | 'manual' | 'stale_open' | 'backfill' | 'gap_fill'
      status            TEXT    NOT NULL DEFAULT 'running',  -- 'running' | 'done' | 'failed' | 'partial'
      started_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      completed_at      TEXT,
      items_synced      INTEGER DEFAULT 0,
      errors_json       TEXT,                     -- JSON array of error messages
      note              TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sync_run_platform ON sync_run(platform, started_at DESC);

    -- ──────────────────────────────────────────────────────────────────────────
    -- token_state: menyimpan token dan status refresh
    -- Token TIDAK PERNAH dikembalikan via API endpoint manapun.
    -- ──────────────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS token_state (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      platform          TEXT    NOT NULL UNIQUE CHECK (platform IN ('instagram','threads','youtube')),
      access_token      TEXT    NOT NULL,
      refresh_token     TEXT,
      token_type        TEXT    DEFAULT 'long_lived',  -- 'long_lived' | 'short_lived' | 'oauth2'
      expires_at        TEXT,                     -- ISO 8601 UTC, NULL = tidak expired (YouTube refresh_token)
      last_refreshed_at TEXT,
      refresh_attempts  INTEGER DEFAULT 0,
      status            TEXT    NOT NULL DEFAULT 'active',  -- 'active' | 'expiring_soon' | 'expired' | 'error'
      error_message     TEXT,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// ── Helper: upsert token ke DB ────────────────────────────────────────────────
function upsertToken(platform, { access_token, refresh_token, token_type, expires_at }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO token_state (platform, access_token, refresh_token, token_type, expires_at, last_refreshed_at, status, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), 'active', datetime('now'))
    ON CONFLICT (platform) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, refresh_token),
      token_type = excluded.token_type,
      expires_at = excluded.expires_at,
      last_refreshed_at = datetime('now'),
      refresh_attempts = 0,
      status = 'active',
      error_message = NULL,
      updated_at = datetime('now')
  `).run(platform, access_token, refresh_token ?? null, token_type ?? 'long_lived', expires_at ?? null);
}

// ── Helper: ambil token dari DB (JANGAN return ke API) ───────────────────────
function getToken(platform) {
  return getDb().prepare('SELECT * FROM token_state WHERE platform = ?').get(platform);
}

// ── Helper: tandai token error ────────────────────────────────────────────────
function markTokenError(platform, message) {
  getDb().prepare(`
    UPDATE token_state 
    SET status = 'error', error_message = ?, refresh_attempts = refresh_attempts + 1, updated_at = datetime('now')
    WHERE platform = ?
  `).run(message, platform);
}

// ── Helper: tandai sync run ───────────────────────────────────────────────────
function startSyncRun(platform, trigger) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO sync_run (platform, trigger, status, started_at)
    VALUES (?, ?, 'running', datetime('now'))
  `).run(platform, trigger);
  return result.lastInsertRowid;
}

function finishSyncRun(runId, { status, itemsSynced, errors, note } = {}) {
  getDb().prepare(`
    UPDATE sync_run SET
      status = ?,
      completed_at = datetime('now'),
      items_synced = ?,
      errors_json = ?,
      note = ?
    WHERE id = ?
  `).run(
    status ?? 'done',
    itemsSynced ?? 0,
    errors ? JSON.stringify(errors) : null,
    note ?? null,
    runId
  );
}

module.exports = { getDb, upsertToken, getToken, markTokenError, startSyncRun, finishSyncRun };
