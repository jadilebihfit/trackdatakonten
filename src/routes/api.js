/**
 * API Routes — per brief Section 7
 * 
 * Endpoints:
 *   GET  /api/overview
 *   GET  /api/contents
 *   GET  /api/contents/:platform/:contentId
 *   GET  /api/contents/:platform/:contentId/extras
 *   GET  /api/compare/platforms
 *   GET  /api/compare/ranking
 *   GET  /api/compare/age-aligned
 *   GET  /api/groups
 *   POST /api/groups
 *   PATCH /api/groups/:id
 *   PATCH /api/contents/:platform/:contentId
 *   GET  /api/sync/status
 *   POST /api/sync
 * 
 * Aturan:
 *   - NULL tetap NULL dalam response (tampilkan sebagai "n/a" di frontend)
 *   - Token TIDAK PERNAH masuk ke response
 *   - Tidak ada write operation ke platform
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { syncPlatform, syncAll, getSyncStatus, isDataStale, isLocked } = require('../services/syncEngine');
const { bootstrapTokensFromEnv } = require('../services/tokenManager');

// ── Helper: validasi platform ────────────────────────────────────────────────
const VALID_PLATFORMS = ['instagram', 'threads', 'youtube', 'all'];

// ── Helper: date range dari query params & timeframe preset ──────────────────
function parseDateRange(query) {
  const today = new Date();
  let to = query.to || today.toISOString().split('T')[0];

  let from = query.from;
  if (!from) {
    const tf = (query.timeframe || '28d').toLowerCase();
    const d = new Date(to);
    if (tf === 'today' || tf === '1d') {
      from = to;
    } else if (tf === 'yesterday') {
      d.setDate(d.getDate() - 1);
      from = d.toISOString().split('T')[0];
      to = from; // Single day range for yesterday
    } else if (tf === '7d') {
      d.setDate(d.getDate() - 7);
      from = d.toISOString().split('T')[0];
    } else if (tf === '28d') {
      d.setDate(d.getDate() - 28);
      from = d.toISOString().split('T')[0];
    } else if (tf === '90d') {
      d.setDate(d.getDate() - 90);
      from = d.toISOString().split('T')[0];
    } else if (tf === '365d' || tf === '1y') {
      d.setDate(d.getDate() - 365);
      from = d.toISOString().split('T')[0];
    } else if (tf === 'all' || tf === 'lifetime') {
      from = '2020-01-01';
    } else {
      d.setDate(d.getDate() - 28);
      from = d.toISOString().split('T')[0];
    }
  }

  return { from, to };
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/overview
// ════════════════════════════════════════════════════════════════════════════
router.get('/overview', async (req, res) => {
  try {
    const { from, to } = parseDateRange(req.query);
    const db = getDb();
    bootstrapTokensFromEnv();

    // Jika DB kosong (misal baru deploy di Vercel), lakukan initial sync otomatis
    const contentCount = db.prepare('SELECT COUNT(*) AS c FROM content').get().c;
    if (contentCount === 0) {
      console.log('[API] DB kosong di Vercel, melakukan initial sync...');
      await syncAll('initial_vercel').catch(err => console.error('[API] Initial sync error:', err.message));
    }

    // KPI aggregat per platform (berdasarkan konten yang dipublikasikan dalam rentang tanggal)
    const kpis = db.prepare(`
      SELECT
        c.platform,
        SUM(COALESCE(s.views, 0))    AS total_views,
        SUM(COALESCE(s.likes, 0))    AS total_likes,
        SUM(COALESCE(s.comments, 0)) AS total_comments,
        SUM(COALESCE(s.shares, 0))   AS total_shares,
        SUM(COALESCE(s.saves, 0))    AS total_saves,
        COUNT(DISTINCT c.id)         AS content_count
      FROM content c
      LEFT JOIN content_metric_snapshot s ON s.content_id = c.id
        AND s.snapshot_date = (
          SELECT MAX(s2.snapshot_date) FROM content_metric_snapshot s2 WHERE s2.content_id = c.id
        )
      WHERE date(c.published_at) BETWEEN ? AND ?
        AND c.is_deleted = 0
      GROUP BY c.platform
    `).all(from, to);

    // Trend harian (gabungan semua platform)
    const trend = db.prepare(`
      SELECT
        date(c.published_at) AS date,
        SUM(COALESCE(s.views, 0))    AS views,
        SUM(COALESCE(s.saves, 0))    AS saves,
        SUM(COALESCE(s.likes, 0))    AS likes,
        SUM(COALESCE(s.shares, 0))   AS shares,
        SUM(COALESCE(s.comments, 0)) AS comments
      FROM content c
      LEFT JOIN content_metric_snapshot s ON s.content_id = c.id
        AND s.snapshot_date = (
          SELECT MAX(s2.snapshot_date) FROM content_metric_snapshot s2 WHERE s2.content_id = c.id
        )
      WHERE date(c.published_at) BETWEEN ? AND ?
        AND c.is_deleted = 0
      GROUP BY date(c.published_at)
      ORDER BY date(c.published_at) ASC
    `).all(from, to);

    // Top performing content (by saves, fallback ke views) dalam rentang tanggal
    const topContent = db.prepare(`
      SELECT
        c.id, c.platform, c.platform_id, c.content_type,
        COALESCE(c.title_override, c.title, SUBSTR(c.caption, 1, 80)) AS display_title,
        c.thumbnail_url, c.url, c.published_at,
        s.views, s.likes, s.saves, s.shares, s.comments,
        s.snapshot_date
      FROM content c
      JOIN content_metric_snapshot s ON s.content_id = c.id
        AND s.snapshot_date = (
          SELECT MAX(s2.snapshot_date) FROM content_metric_snapshot s2 WHERE s2.content_id = c.id
        )
      WHERE date(c.published_at) BETWEEN ? AND ?
        AND c.is_deleted = 0
      ORDER BY COALESCE(s.saves, 0) DESC, COALESCE(s.views, 0) DESC
      LIMIT 5
    `).all(from, to);

    // Account daily (latest per platform)
    const accounts = db.prepare(`
      SELECT a.* FROM account_daily a
      INNER JOIN (
        SELECT platform, MAX(date) AS max_date FROM account_daily GROUP BY platform
      ) latest ON a.platform = latest.platform AND a.date = latest.max_date
    `).all();

    // Stale check
    const staleInfo = {};
    for (const p of ['instagram', 'threads', 'youtube']) {
      staleInfo[p] = isDataStale(p);
    }

    res.json({
      dateRange: { from, to },
      platforms: kpis,
      trend,
      topContent,
      accounts,
      dataWarnings: {
        stale: staleInfo,
        instagramHistoricalNote: 'Instagram/Threads: riwayat hanya tersedia sejak sync pertama. Data historis sebelumnya tidak dapat diambil dari API.',
        youtubeTimezoneNote: 'YouTube Analytics menggunakan timezone Pacific (bukan WIB). Tanggal disimpan apa adanya.'
      }
    });
  } catch (e) {
    console.error('[API] /overview error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/contents
// ════════════════════════════════════════════════════════════════════════════
router.get('/contents', (req, res) => {
  try {
    const { platform, format, q, sort = 'published_at', order = 'DESC', page = 1, pageSize = 20 } = req.query;
    const { from, to } = parseDateRange(req.query);
    const db = getDb();

    const conditions = ['c.is_deleted = 0', 'date(c.published_at) BETWEEN ? AND ?'];
    const params = [from, to];

    if (platform && platform !== 'all') {
      conditions.push('c.platform = ?');
      params.push(platform);
    }
    if (format) {
      conditions.push('c.content_type = ?');
      params.push(format.toUpperCase());
    }
    if (q) {
      conditions.push(`(c.title LIKE ? OR c.caption LIKE ? OR c.title_override LIKE ?)`);
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    const allowedSort = ['published_at', 'views', 'likes', 'saves', 'shares', 'comments'];
    const safeSort = allowedSort.includes(sort) ? sort : 'published_at';
    const safeOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const offset = (parseInt(page) - 1) * parseInt(pageSize);

    const where = conditions.join(' AND ');

    const total = db.prepare(`
      SELECT COUNT(DISTINCT c.id) AS count
      FROM content c
      WHERE ${where}
    `).get(...params).count;

    const sortCol = safeSort === 'published_at' ? 'c.published_at' : `COALESCE(s.${safeSort}, 0)`;

    const contents = db.prepare(`
      SELECT
        c.id, c.platform, c.platform_id, c.content_type,
        COALESCE(c.title_override, c.title, SUBSTR(c.caption, 1, 80)) AS display_title,
        c.title_override, c.title, c.caption,
        c.thumbnail_url, c.url, c.published_at, c.duration_seconds, c.last_synced_at,
        s.views, s.likes, s.saves, s.shares, s.comments, s.reach, s.impressions,
        s.reposts, s.quotes,
        s.estimated_minutes_watched, s.average_view_duration, s.average_view_percentage,
        s.subscribers_gained, s.subscribers_lost,
        s.snapshot_date
      FROM content c
      LEFT JOIN content_metric_snapshot s ON s.content_id = c.id
        AND s.snapshot_date = (
          SELECT MAX(s2.snapshot_date) FROM content_metric_snapshot s2 WHERE s2.content_id = c.id
        )
      WHERE ${where}
      ORDER BY ${sortCol} ${safeOrder}
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(pageSize), offset);

    res.json({
      contents,
      pagination: {
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        total,
        totalPages: Math.ceil(total / parseInt(pageSize))
      },
      dateRange: { from, to }
    });
  } catch (e) {
    console.error('[API] /contents error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/contents/:platform/:contentId
// ════════════════════════════════════════════════════════════════════════════
router.get('/contents/:platform/:contentId', (req, res) => {
  try {
    const { platform, contentId } = req.params;
    const db = getDb();

    const content = db.prepare(`
      SELECT c.*, 
        COALESCE(c.title_override, c.title, SUBSTR(c.caption, 1, 80)) AS display_title
      FROM content c
      WHERE c.platform = ? AND c.platform_id = ?
    `).get(platform, contentId);

    if (!content) return res.status(404).json({ error: 'Content not found' });

    // Semua snapshots (riwayat metrik)
    const snapshots = db.prepare(`
      SELECT * FROM content_metric_snapshot
      WHERE content_id = ?
      ORDER BY snapshot_date ASC
    `).all(content.id);

    res.json({ content, snapshots });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/contents/:platform/:contentId/extras
// ════════════════════════════════════════════════════════════════════════════
router.get('/contents/:platform/:contentId/extras', (req, res) => {
  try {
    const { platform, contentId } = req.params;
    const db = getDb();

    const content = db.prepare('SELECT id FROM content WHERE platform = ? AND platform_id = ?').get(platform, contentId);
    if (!content) return res.status(404).json({ error: 'Content not found' });

    const comments = db.prepare(`
      SELECT * FROM comment WHERE content_id = ?
      ORDER BY published_at DESC LIMIT 100
    `).all(content.id);

    res.json({ comments });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH /api/contents/:platform/:contentId  (title_override only)
// ════════════════════════════════════════════════════════════════════════════
router.patch('/contents/:platform/:contentId', (req, res) => {
  try {
    const { platform, contentId } = req.params;
    const { title_override } = req.body;
    const db = getDb();

    const result = db.prepare(`
      UPDATE content SET title_override = ?, updated_at = datetime('now')
      WHERE platform = ? AND platform_id = ?
    `).run(title_override ?? null, platform, contentId);

    if (result.changes === 0) return res.status(404).json({ error: 'Content not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/compare/platforms
// ════════════════════════════════════════════════════════════════════════════
router.get('/compare/platforms', (req, res) => {
  try {
    const { metric = 'views' } = req.query;
    const { from, to } = parseDateRange(req.query);
    const db = getDb();

    const allowedMetrics = ['views', 'likes', 'saves', 'shares', 'comments', 'reach'];
    const safeMetric = allowedMetrics.includes(metric) ? metric : 'views';

    const data = db.prepare(`
      SELECT
        c.platform,
        s.snapshot_date AS date,
        SUM(s.${safeMetric}) AS value
      FROM content_metric_snapshot s
      JOIN content c ON c.id = s.content_id
      WHERE s.snapshot_date BETWEEN ? AND ? AND c.is_deleted = 0
      GROUP BY c.platform, s.snapshot_date
      ORDER BY s.snapshot_date ASC
    `).all(from, to);

    res.json({ metric: safeMetric, dateRange: { from, to }, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/compare/ranking
// ════════════════════════════════════════════════════════════════════════════
router.get('/compare/ranking', (req, res) => {
  try {
    const { metric = 'views', limit = 20 } = req.query;
    const { from, to } = parseDateRange(req.query);
    const db = getDb();

    const allowedMetrics = ['views', 'likes', 'saves', 'shares', 'comments'];
    const safeMetric = allowedMetrics.includes(metric) ? metric : 'views';

    const data = db.prepare(`
      SELECT
        c.platform, c.platform_id, c.content_type,
        COALESCE(c.title_override, c.title, SUBSTR(c.caption, 1, 60)) AS display_title,
        c.thumbnail_url, c.url, c.published_at,
        MAX(s.${safeMetric}) AS metric_value
      FROM content_metric_snapshot s
      JOIN content c ON c.id = s.content_id
      WHERE s.snapshot_date BETWEEN ? AND ? AND c.is_deleted = 0
      GROUP BY c.id
      ORDER BY metric_value DESC NULLS LAST
      LIMIT ?
    `).all(from, to, parseInt(limit));

    res.json({ metric: safeMetric, dateRange: { from, to }, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/compare/age-aligned
// ════════════════════════════════════════════════════════════════════════════
router.get('/compare/age-aligned', (req, res) => {
  try {
    const days = (req.query.days || '1,3,7,28').split(',').map(Number).filter(d => d > 0);
    const db = getDb();

    const data = db.prepare(`
      SELECT
        c.platform, c.platform_id, c.content_type,
        COALESCE(c.title_override, c.title, SUBSTR(c.caption, 1, 60)) AS display_title,
        c.published_at,
        s.views, s.likes, s.saves, s.snapshot_date,
        CAST(julianday(s.snapshot_date) - julianday(c.published_at) AS INTEGER) AS days_after_publish
      FROM content_metric_snapshot s
      JOIN content c ON c.id = s.content_id
      WHERE CAST(julianday(s.snapshot_date) - julianday(c.published_at) AS INTEGER) IN (${days.map(() => '?').join(',')})
        AND c.is_deleted = 0
      ORDER BY c.published_at DESC, days_after_publish ASC
    `).all(...days);

    res.json({ days, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Groups CRUD
// ════════════════════════════════════════════════════════════════════════════
router.get('/groups', (req, res) => {
  try {
    const db = getDb();
    const groups = db.prepare('SELECT * FROM content_group ORDER BY created_at DESC').all();
    for (const g of groups) {
      g.members = db.prepare(`
        SELECT c.platform, c.platform_id, 
          COALESCE(c.title_override, c.title, SUBSTR(c.caption, 1, 60)) AS display_title
        FROM content_group_member m JOIN content c ON c.id = m.content_id
        WHERE m.group_id = ?
      `).all(g.id);
    }
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/groups', (req, res) => {
  try {
    const { name, description, contentIds = [] } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const db = getDb();

    const result = db.prepare('INSERT INTO content_group (name, description) VALUES (?, ?)').run(name, description ?? null);
    const groupId = result.lastInsertRowid;

    for (const contentId of contentIds) {
      try {
        db.prepare('INSERT OR IGNORE INTO content_group_member (group_id, content_id) VALUES (?, ?)').run(groupId, contentId);
      } catch {}
    }

    res.status(201).json({ id: groupId, name, description });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/groups/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, addContentIds = [], removeContentIds = [] } = req.body;
    const db = getDb();

    if (name || description !== undefined) {
      db.prepare(`
        UPDATE content_group SET
          name = COALESCE(?, name),
          description = COALESCE(?, description),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(name ?? null, description ?? null, id);
    }

    for (const cId of addContentIds) {
      db.prepare('INSERT OR IGNORE INTO content_group_member (group_id, content_id) VALUES (?, ?)').run(id, cId);
    }
    for (const cId of removeContentIds) {
      db.prepare('DELETE FROM content_group_member WHERE group_id = ? AND content_id = ?').run(id, cId);
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/sync/status
// ════════════════════════════════════════════════════════════════════════════
router.get('/sync/status', (req, res) => {
  try {
    res.json(getSyncStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/sync
// ════════════════════════════════════════════════════════════════════════════
router.post('/sync', async (req, res) => {
  try {
    const { platform } = req.query;

    if (platform && platform !== 'all') {
      if (!VALID_PLATFORMS.includes(platform)) {
        return res.status(400).json({ error: `Invalid platform. Must be one of: ${VALID_PLATFORMS.join(', ')}` });
      }
      if (isLocked(platform)) {
        return res.status(409).json({ error: `Sync for ${platform} already running` });
      }
    }

    // Jalankan async — response langsung (tidak block)
    res.json({ message: `Sync started for ${platform || 'all platforms'}`, trigger: 'manual' });

    // Background sync
    if (!platform || platform === 'all') {
      syncAll('manual').catch(e => console.error('[API] manual syncAll error:', e.message));
    } else {
      syncPlatform(platform, 'manual').catch(e => console.error(`[API] manual sync error for ${platform}:`, e.message));
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
