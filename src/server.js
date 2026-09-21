/**
 * Server — Entry Point
 * 
 * Startup sequence:
 *   1. Init DB schema
 *   2. Bootstrap tokens dari .env ke DB
 *   3. Start Express
 *   4. Register scheduler (node-cron)
 *   5. Trigger initial sync jika data stale
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');

const { getDb } = require('./db/database');
const { bootstrapTokensFromEnv, checkAndRefreshTokens } = require('./services/tokenManager');
const { syncAll, isDataStale } = require('./services/syncEngine');
const apiRouter = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// CORS untuk development
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api', apiRouter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), time: new Date().toISOString() });
});

// ── SPA fallback (semua route lain ke index.html) ─────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ════════════════════════════════════════════════════════════════════════════
// STARTUP
// ════════════════════════════════════════════════════════════════════════════
async function startup() {
  try {
    // 1. Init DB
    console.log('[Startup] Initializing database...');
    getDb(); // Triggers schema creation
    console.log('[Startup] Database OK');

    // 2. Bootstrap tokens
    console.log('[Startup] Bootstrapping tokens from .env...');
    bootstrapTokensFromEnv();

    // 3. Start server
    app.listen(PORT, () => {
      console.log(`\n${'═'.repeat(55)}`);
      console.log(`  Asistent Creator — running on http://localhost:${PORT}`);
      console.log(`${'═'.repeat(55)}\n`);
    });

    // 4. Register schedulers (node-cron)
    const syncIntervalMinutes = parseInt(process.env.SYNC_INTERVAL_MINUTES || 30);

    // Sync otomatis setiap N menit (default: setiap 30 menit)
    // Cron format: */30 * * * * (setiap 30 menit)
    const syncCron = syncIntervalMinutes >= 60
      ? `0 */${Math.floor(syncIntervalMinutes / 60)} * * *`
      : `*/${syncIntervalMinutes} * * * *`;

    cron.schedule(syncCron, async () => {
      console.log(`[Scheduler] Auto-sync triggered by cron (${syncCron})`);
      await syncAll('scheduled').catch(e => console.error('[Scheduler] syncAll error:', e.message));
    }, { timezone: process.env.APP_TIMEZONE || 'Asia/Jakarta' });

    // Daily accumulation & token check harian jam 16:30 WIB (Setengah 5 Sore)
    cron.schedule('30 16 * * *', async () => {
      console.log('[Scheduler] Daily accumulation & token check triggered at 16:30 WIB (Setengah 5 Sore)...');
      await checkAndRefreshTokens().catch(e => console.error('[Scheduler] token check error:', e.message));
      await syncAll('daily_accumulation').catch(e => console.error('[Scheduler] daily accumulation sync error:', e.message));
    }, { timezone: process.env.APP_TIMEZONE || 'Asia/Jakarta' });

    console.log(`[Startup] Schedulers registered:`);
    console.log(`  Sync: every ${syncIntervalMinutes} minutes (cron: ${syncCron})`);
    console.log(`  Daily accumulation & Token check: daily at 16:30 WIB (Setengah 5 Sore)`);

    // 5. Initial sync jika data stale atau belum pernah sync
    const needsInitialSync = isDataStale('instagram') || isDataStale('threads') || isDataStale('youtube');
    if (needsInitialSync) {
      console.log('[Startup] Data is stale or empty — triggering initial sync...');
      // Jalankan di background, jangan block startup
      setTimeout(() => {
        syncAll('scheduled').catch(e => console.error('[Startup] initial sync error:', e.message));
      }, 2000);
    } else {
      console.log('[Startup] Data is fresh. Next sync via scheduler.');
    }

  } catch (e) {
    console.error('[Startup] Fatal error:', e.message);
    process.exit(1);
  }
}

startup();

module.exports = app;
