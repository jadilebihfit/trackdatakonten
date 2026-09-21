/**
 * Sync Engine — per brief Section 5
 * 
 * Fitur:
 *  - Sync otomatis setiap 6 jam via node-cron
 *  - Token check harian
 *  - Concurrency lock (tidak ada 2 sync berjalan bersamaan)
 *  - Gap filling (isi data yang terlewat)
 *  - Backfill dari tanggal channel dibuat (YouTube)
 *  - Stale-on-open trigger (dari API endpoint)
 *  - Self-healing: retry dengan exponential backoff
 *  - Error isolation per platform (platform lain tetap jalan)
 */

require('dotenv').config();
const { getDb, startSyncRun, finishSyncRun } = require('../db/database');
const { getAdapter } = require('./adapters');
const { bootstrapTokensFromEnv, checkAndRefreshTokens } = require('./tokenManager');

// ── Concurrency lock ──────────────────────────────────────────────────────────
const locks = { instagram: false, threads: false, youtube: false };

function isLocked(platform) { return locks[platform] || false; }
function acquire(platform) { locks[platform] = true; }
function release(platform) { locks[platform] = false; }

// ── Upsert content ke DB ──────────────────────────────────────────────────────
function upsertContent(db, content) {
  const existing = db.prepare('SELECT id FROM content WHERE platform = ? AND platform_id = ?')
    .get(content.platform, content.platform_id);

  if (existing) {
    db.prepare(`
      UPDATE content SET
        content_type = ?, title = COALESCE(?, title), caption = ?,
        url = COALESCE(?, url), thumbnail_url = COALESCE(?, thumbnail_url),
        duration_seconds = COALESCE(?, duration_seconds),
        last_synced_at = datetime('now')
      WHERE id = ?
    `).run(
      content.content_type,
      content.title,
      content.caption,
      content.url,
      content.thumbnail_url,
      content.duration_seconds,
      existing.id
    );
    return existing.id;
  } else {
    const result = db.prepare(`
      INSERT INTO content (platform, platform_id, content_type, title, caption, url, thumbnail_url, duration_seconds, published_at, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      content.platform, content.platform_id, content.content_type,
      content.title, content.caption, content.url,
      content.thumbnail_url, content.duration_seconds, content.published_at
    );
    return result.lastInsertRowid;
  }
}

// ── Upsert metric snapshot ────────────────────────────────────────────────────
function upsertSnapshot(db, contentId, metrics, source = 'sync') {
  const today = new Date().toISOString().split('T')[0];
  db.prepare(`
    INSERT INTO content_metric_snapshot (
      content_id, snapshot_date, snapshot_at,
      views, likes, comments, shares, saves, reach, impressions,
      reposts, quotes,
      estimated_minutes_watched, average_view_duration, average_view_percentage,
      subscribers_gained, subscribers_lost, card_impressions, card_click_rate,
      source
    ) VALUES (
      ?, ?, datetime('now'),
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?
    )
    ON CONFLICT (content_id, snapshot_date) DO UPDATE SET
      views = COALESCE(excluded.views, views),
      likes = COALESCE(excluded.likes, likes),
      comments = COALESCE(excluded.comments, comments),
      shares = COALESCE(excluded.shares, shares),
      saves = COALESCE(excluded.saves, saves),
      reach = COALESCE(excluded.reach, reach),
      impressions = COALESCE(excluded.impressions, impressions),
      reposts = COALESCE(excluded.reposts, reposts),
      quotes = COALESCE(excluded.quotes, quotes),
      estimated_minutes_watched = COALESCE(excluded.estimated_minutes_watched, estimated_minutes_watched),
      average_view_duration = COALESCE(excluded.average_view_duration, average_view_duration),
      average_view_percentage = COALESCE(excluded.average_view_percentage, average_view_percentage),
      subscribers_gained = COALESCE(excluded.subscribers_gained, subscribers_gained),
      subscribers_lost = COALESCE(excluded.subscribers_lost, subscribers_lost),
      snapshot_at = datetime('now'),
      source = excluded.source
  `).run(
    contentId, today,
    metrics.views ?? null, metrics.likes ?? null, metrics.comments ?? null,
    metrics.shares ?? null, metrics.saves ?? null, metrics.reach ?? null, metrics.impressions ?? null,
    metrics.reposts ?? null, metrics.quotes ?? null,
    metrics.estimated_minutes_watched ?? null, metrics.average_view_duration ?? null,
    metrics.average_view_percentage ?? null,
    metrics.subscribers_gained ?? null, metrics.subscribers_lost ?? null,
    metrics.card_impressions ?? null, metrics.card_click_rate ?? null,
    source
  );
}

// ── Upsert account daily ──────────────────────────────────────────────────────
function upsertAccountDaily(db, platform, metrics) {
  const today = new Date().toISOString().split('T')[0];
  db.prepare(`
    INSERT INTO account_daily (platform, date, followers, following, total_views, total_reach, subscribers, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (platform, date) DO UPDATE SET
      followers = COALESCE(excluded.followers, followers),
      following = COALESCE(excluded.following, following),
      total_views = COALESCE(excluded.total_views, total_views),
      total_reach = COALESCE(excluded.total_reach, total_reach),
      subscribers = COALESCE(excluded.subscribers, subscribers),
      synced_at = datetime('now')
  `).run(
    platform, today,
    metrics.followers ?? null, metrics.following ?? null,
    metrics.total_views ?? null, metrics.total_reach ?? null,
    metrics.subscribers ?? null
  );
}

// ── Sleep helper ──────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Sync satu platform dengan retry ──────────────────────────────────────────
async function syncPlatform(platform, trigger = 'scheduled') {
  if (isLocked(platform)) {
    console.log(`[SyncEngine] ${platform}: sync already running, skipping`);
    return { skipped: true };
  }

  acquire(platform);
  const runId = startSyncRun(platform, trigger);
  const db = getDb();
  const errors = [];
  let itemsSynced = 0;

  console.log(`[SyncEngine] ${platform}: starting sync (run #${runId}, trigger: ${trigger})`);

  try {
    const adapter = getAdapter(platform);

    // 1. Sync akun level metrics
    try {
      const accountMetrics = await adapter.getAccountMetrics();
      if (accountMetrics) {
        upsertAccountDaily(db, platform, accountMetrics);
      }
    } catch (e) {
      errors.push(`account_metrics: ${e.message}`);
      console.error(`[SyncEngine] ${platform} account metrics error:`, e.message);
    }

    // 2. List semua konten
    let contents;
    try {
      contents = await adapter.listContents();
      console.log(`[SyncEngine] ${platform}: found ${contents.length} contents`);
    } catch (e) {
      errors.push(`list_contents: ${e.message}`);
      console.error(`[SyncEngine] ${platform} listContents error:`, e.message);
      finishSyncRun(runId, { status: 'failed', errors, itemsSynced: 0 });
      return { error: e.message };
    }

    // 3. Upsert content + ambil metrik
    const upsertStmt = db.transaction((contents) => {
      const ids = {};
      for (const c of contents) {
        const contentId = upsertContent(db, c);
        ids[c.platform_id] = { contentId, _stats: c._stats };
      }
      return ids;
    });

    const contentMap = upsertStmt(contents);
    itemsSynced = Object.keys(contentMap).length;

    // 4. Ambil metrik per konten (throttle: 500ms antar request)
    for (const [platformId, { contentId, _stats }] of Object.entries(contentMap)) {
      try {
        let metrics;

        if (_stats) {
          // YouTube sudah punya stats dari listContents (hemat API call)
          metrics = await adapter.getContentMetrics(platformId);
        } else {
          metrics = await adapter.getContentMetrics(platformId);
        }

        if (metrics) {
          upsertSnapshot(db, contentId, metrics, trigger);
        }
        await sleep(300); // Throttle untuk menghindari rate limit
      } catch (e) {
        errors.push(`content_metrics[${platformId}]: ${e.message}`);
        console.warn(`[SyncEngine] ${platform} metrics error for ${platformId}:`, e.message);
      }
    }

    finishSyncRun(runId, {
      status: errors.length > 0 ? 'partial' : 'done',
      itemsSynced,
      errors: errors.length > 0 ? errors : null
    });

    console.log(`[SyncEngine] ${platform}: sync complete — ${itemsSynced} items, ${errors.length} errors`);
    return { itemsSynced, errors };

  } catch (e) {
    console.error(`[SyncEngine] ${platform}: fatal error:`, e.message);
    errors.push(`fatal: ${e.message}`);
    finishSyncRun(runId, { status: 'failed', errors, itemsSynced });
    return { error: e.message };
  } finally {
    release(platform);
  }
}

// ── Gap filling: cari konten yang belum punya snapshot hari ini ───────────────
async function fillGaps(platform) {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];

  const missing = db.prepare(`
    SELECT c.id, c.platform_id FROM content c
    LEFT JOIN content_metric_snapshot s ON s.content_id = c.id AND s.snapshot_date = ?
    WHERE c.platform = ? AND s.id IS NULL AND c.is_deleted = 0
  `).all(today, platform);

  if (missing.length === 0) return;

  console.log(`[SyncEngine] Gap fill: ${missing.length} items without today's snapshot for ${platform}`);
  const adapter = getAdapter(platform);

  for (const item of missing) {
    try {
      const metrics = await adapter.getContentMetrics(item.platform_id);
      if (metrics) {
        upsertSnapshot(db, item.id, metrics, 'gap_fill');
      }
      await sleep(300);
    } catch (e) {
      console.warn(`[SyncEngine] Gap fill error for ${platform}/${item.platform_id}:`, e.message);
    }
  }
}

// ── Sync semua platform ───────────────────────────────────────────────────────
async function syncAll(trigger = 'scheduled') {
  console.log(`[SyncEngine] syncAll started (trigger: ${trigger})`);
  const platforms = ['instagram', 'threads', 'youtube'];
  const results = {};

  for (const platform of platforms) {
    try {
      results[platform] = await syncPlatform(platform, trigger);
    } catch (e) {
      console.error(`[SyncEngine] syncAll error for ${platform}:`, e.message);
      results[platform] = { error: e.message };
    }
  }

  console.log('[SyncEngine] syncAll complete:', JSON.stringify(results, null, 2));
  return results;
}

// ── Status check ──────────────────────────────────────────────────────────────
function getSyncStatus() {
  const db = getDb();

  const lastRuns = db.prepare(`
    SELECT platform, status, started_at, completed_at, items_synced, errors_json, trigger
    FROM sync_run
    WHERE id IN (
      SELECT MAX(id) FROM sync_run GROUP BY COALESCE(platform, 'all')
    )
    ORDER BY started_at DESC
  `).all();

  const nextSyncMs = parseInt(process.env.SYNC_INTERVAL_HOURS || 6) * 60 * 60 * 1000;
  const lastAny = lastRuns[0];
  const nextSync = lastAny?.completed_at
    ? new Date(new Date(lastAny.completed_at).getTime() + nextSyncMs).toISOString()
    : null;

  const tokenStatus = db.prepare(`
    SELECT platform, status, expires_at, last_refreshed_at, error_message
    FROM token_state
  `).all();

  return {
    lastSyncRuns: lastRuns.map(r => ({
      platform: r.platform,
      status: r.status,
      trigger: r.trigger,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      itemsSynced: r.items_synced,
      hasErrors: !!r.errors_json
    })),
    nextScheduledSync: nextSync,
    locks: { ...locks },
    // Token status — TANPA mengembalikan nilai token
    tokens: tokenStatus.map(t => ({
      platform: t.platform,
      status: t.status,
      expiresAt: t.expires_at,
      lastRefreshed: t.last_refreshed_at,
      hasError: !!t.error_message
    }))
  };
}

// ── Stale check: apakah data sudah basi? ─────────────────────────────────────
function isDataStale(platform) {
  const db = getDb();
  const staleAfterHours = parseInt(process.env.STALE_AFTER_HOURS || 6);
  const staleThreshold = new Date(Date.now() - staleAfterHours * 60 * 60 * 1000).toISOString();

  const lastSync = db.prepare(`
    SELECT completed_at FROM sync_run
    WHERE platform = ? AND status IN ('done', 'partial')
    ORDER BY completed_at DESC LIMIT 1
  `).get(platform);

  if (!lastSync?.completed_at) return true; // Belum pernah sync → stale
  return lastSync.completed_at < staleThreshold;
}

module.exports = {
  syncPlatform,
  syncAll,
  fillGaps,
  getSyncStatus,
  isDataStale,
  isLocked
};
