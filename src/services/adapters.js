/**
 * Platform Adapters — per brief Section 5.7
 * 
 * Setiap adapter mengimplementasikan interface PlatformAdapter:
 *   - listContents()             → array of content objects
 *   - getContentMetrics(id)      → metric snapshot
 *   - getAccountMetrics()        → account-level daily metrics
 *   - getComments(id, limit)     → array of comments
 *   - refreshToken()             → handled by tokenManager
 * 
 * Aturan:
 *   - NULL ≠ 0. Metric tidak tersedia → null, bukan 0.
 *   - Dilarang scraping. Hanya official API.
 *   - Read-only. Tidak ada write operation.
 *   - Token hanya di server. Tidak pernah di-log atau dikembalikan ke client.
 */

require('dotenv').config();
const https = require('https');
const { getAccessToken } = require('./tokenManager');

// ── HTTP helper ───────────────────────────────────────────────────────────────
function apiGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    }).on('error', reject);
  });
}

function nullify(val) {
  // API sering mengembalikan 0 untuk metric yang benar-benar 0 atau tidak tersedia.
  // Kita percaya API: 0 tetap 0, undefined/null → null.
  return val === undefined || val === null ? null : val;
}

// ══════════════════════════════════════════════════════════════════════════════
// INSTAGRAM ADAPTER
// ══════════════════════════════════════════════════════════════════════════════
const instagramAdapter = {
  platform: 'instagram',

  // Metric yang tersedia berdasarkan hasil verify-apis.js
  METRIC_SETS: {
    IMAGE:    ['impressions', 'reach', 'saved', 'likes', 'comments', 'shares', 'total_interactions'],
    CAROUSEL: ['impressions', 'reach', 'saved', 'likes', 'comments', 'shares', 'total_interactions'],
    VIDEO:    ['views', 'reach', 'saved', 'likes', 'comments', 'shares', 'total_interactions'],
    REEL:     ['views', 'reach', 'saved', 'likes', 'comments', 'shares', 'total_interactions'],
    REELS:    ['views', 'reach', 'saved', 'likes', 'comments', 'shares', 'total_interactions'],
    STORY:    ['impressions', 'reach', 'exits', 'replies', 'taps_forward', 'taps_back']
  },

  async listContents() {
    const token = await getAccessToken('instagram');
    const base = `https://graph.instagram.com/v23.0`;
    const fields = 'id,caption,media_type,media_product_type,permalink,timestamp,thumbnail_url,like_count,comments_count';

    const contents = [];
    let url = `${base}/me/media?fields=${fields}&limit=50&access_token=${token}`;

    // Paginate semua konten
    while (url) {
      const { status, data } = await apiGet(url);
      if (status !== 200 || !Array.isArray(data.data)) {
        console.error(`[Instagram] listContents error: ${status}`, data?.error?.message || '');
        break;
      }
      for (const item of data.data) {
        contents.push({
          platform: 'instagram',
          platform_id: item.id,
          content_type: item.media_product_type || item.media_type,
          title: null,
          caption: item.caption || null,
          url: item.permalink || null,
          thumbnail_url: item.thumbnail_url || null,
          duration_seconds: null,
          published_at: new Date(item.timestamp).toISOString()
        });
      }
      url = data.paging?.next || null;
    }

    return contents;
  },

  async getContentMetrics(platformId) {
    const token = await getAccessToken('instagram');
    const base = `https://graph.instagram.com/v23.0`;

    // Ambil info dasar dulu untuk tahu type
    const infoRes = await apiGet(`${base}/${platformId}?fields=media_type,media_product_type,like_count,comments_count&access_token=${token}`);
    if (infoRes.status !== 200) return null;

    const type = infoRes.data.media_product_type || infoRes.data.media_type;
    const metrics = this.METRIC_SETS[type] || this.METRIC_SETS.IMAGE;

    let insightData = {};
    try {
      const insRes = await apiGet(`${base}/${platformId}/insights?metric=${metrics.join(',')}&access_token=${token}`);
      if (insRes.status === 200 && Array.isArray(insRes.data.data)) {
        insRes.data.data.forEach(d => { insightData[d.name] = d.values?.[0]?.value ?? d.value ?? null; });
      }
    } catch {}

    return {
      views:       nullify(insightData.views ?? insightData.impressions),
      likes:       nullify(infoRes.data.like_count),
      comments:    nullify(infoRes.data.comments_count),
      shares:      nullify(insightData.shares),
      saves:       nullify(insightData.saved),   // API field = 'saved', kita simpan sebagai 'saves'
      reach:       nullify(insightData.reach),
      impressions: nullify(insightData.impressions)
    };
  },

  async getAccountMetrics() {
    const token = await getAccessToken('instagram');
    const base = `https://graph.instagram.com/v23.0`;

    const r = await apiGet(`${base}/me?fields=id,followers_count,media_count&access_token=${token}`);
    if (r.status !== 200) return null;

    return {
      followers: nullify(r.data.followers_count),
      following: null,  // Tidak tersedia di Instagram Graph API
      total_views: null
    };
  },

  async getComments(platformId, limit = 50) {
    const token = await getAccessToken('instagram');
    const base = `https://graph.instagram.com/v23.0`;
    const fields = 'id,text,username,timestamp,like_count,replies{id,text,username,timestamp,like_count}';

    const r = await apiGet(`${base}/${platformId}/comments?fields=${fields}&limit=${limit}&access_token=${token}`);
    if (r.status !== 200 || !Array.isArray(r.data.data)) return [];

    const comments = [];
    for (const c of r.data.data) {
      comments.push({
        platform_comment_id: c.id,
        author_name: c.username || null,
        author_id: null,
        text: c.text,
        like_count: c.like_count || 0,
        published_at: new Date(c.timestamp).toISOString(),
        parent_comment_id: null
      });
      // Replies
      for (const r2 of (c.replies?.data || [])) {
        comments.push({
          platform_comment_id: r2.id,
          author_name: r2.username || null,
          author_id: null,
          text: r2.text,
          like_count: r2.like_count || 0,
          published_at: new Date(r2.timestamp).toISOString(),
          parent_platform_id: c.id
        });
      }
    }
    return comments;
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// THREADS ADAPTER
// ══════════════════════════════════════════════════════════════════════════════
const threadsAdapter = {
  platform: 'threads',

  async listContents() {
    const token = await getAccessToken('threads');
    const base = `https://graph.threads.net/v1.0`;
    const fields = 'id,text,media_type,permalink,timestamp';

    const contents = [];
    let url = `${base}/me/threads?fields=${fields}&limit=50&access_token=${token}`;

    while (url) {
      const { status, data } = await apiGet(url);
      if (status !== 200 || !Array.isArray(data.data)) {
        console.error(`[Threads] listContents error: ${status}`, data?.error?.message || '');
        break;
      }
      for (const item of data.data) {
        contents.push({
          platform: 'threads',
          platform_id: item.id,
          content_type: 'THREAD',
          title: null,
          caption: item.text || null,
          url: item.permalink || null,
          thumbnail_url: null,
          duration_seconds: null,
          published_at: new Date(item.timestamp).toISOString()
        });
      }
      url = data.paging?.next || null;
    }

    return contents;
  },

  async getContentMetrics(platformId) {
    const token = await getAccessToken('threads');
    const base = `https://graph.threads.net/v1.0`;
    const metrics = 'views,likes,replies,reposts,quotes,shares';

    const r = await apiGet(`${base}/${platformId}/insights?metric=${metrics}&access_token=${token}`);
    if (r.status !== 200 || !Array.isArray(r.data.data)) return null;

    const data = {};
    r.data.data.forEach(d => { data[d.name] = d.values?.[0]?.value ?? d.value ?? null; });

    return {
      views:    nullify(data.views),
      likes:    nullify(data.likes),
      comments: nullify(data.replies),
      shares:   nullify(data.shares ?? data.reposts),
      saves:    null,  // Tidak ada di Threads API
      reposts:  nullify(data.reposts),
      quotes:   nullify(data.quotes),
      reach:    null,
      impressions: null
    };
  },

  async getAccountMetrics() {
    const token = await getAccessToken('threads');
    const base = `https://graph.threads.net/v1.0`;
    const metrics = 'views,likes,replies,reposts,followers_count';

    const r = await apiGet(`${base}/me/threads_insights?metric=${metrics}&access_token=${token}`);
    if (r.status !== 200) return null;

    const data = {};
    if (Array.isArray(r.data.data)) {
      r.data.data.forEach(d => { data[d.name] = d.values?.[0]?.value ?? d.value ?? null; });
    }

    return {
      followers: nullify(data.followers_count),
      following: null,
      total_views: nullify(data.views)
    };
  },

  async getComments(platformId, limit = 50) {
    const token = await getAccessToken('threads');
    const base = `https://graph.threads.net/v1.0`;

    const r = await apiGet(`${base}/${platformId}/replies?fields=id,text,username,timestamp&limit=${limit}&access_token=${token}`);
    if (r.status !== 200 || !Array.isArray(r.data.data)) return [];

    return r.data.data.map(c => ({
      platform_comment_id: c.id,
      author_name: c.username || null,
      author_id: null,
      text: c.text || '',
      like_count: 0,
      published_at: new Date(c.timestamp).toISOString(),
      parent_comment_id: null
    }));
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// YOUTUBE ADAPTER
// ══════════════════════════════════════════════════════════════════════════════
const youtubeAdapter = {
  platform: 'youtube',

  async _getUploadsPlaylistId(token) {
    const r = await apiGet(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails,statistics&mine=true&access_token=${token}`);
    if (r.status !== 200 || !r.data.items?.length) throw new Error('YouTube channel not found');
    this._channelStats = r.data.items[0].statistics;
    return r.data.items[0].contentDetails.relatedPlaylists.uploads;
  },

  async listContents() {
    const token = await getAccessToken('youtube');
    await this._fetchBatchAnalytics(token);
    const playlistId = await this._getUploadsPlaylistId(token);

    const videoIds = [];
    let pageToken = '';

    // Paginate semua video dari uploads playlist
    do {
      const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${playlistId}&maxResults=50&pageToken=${pageToken}&access_token=${token}`;
      const { status, data } = await apiGet(url);
      if (status !== 200) break;
      (data.items || []).forEach(i => videoIds.push(i.contentDetails.videoId));
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    const contents = [];

    // Ambil detail video dalam batch 50
    for (let i = 0; i < videoIds.length; i += 50) {
      const batch = videoIds.slice(i, i + 50).join(',');
      const r = await apiGet(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${batch}&access_token=${token}`);
      if (r.status !== 200 || !Array.isArray(r.data.items)) continue;

      for (const v of r.data.items) {
        // Parse ISO 8601 duration ke detik
        let seconds = null;
        const dur = v.contentDetails?.duration;
        if (dur) {
          const m = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
          if (m) seconds = (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
        }

        const isShort = seconds !== null && seconds <= 60;

        contents.push({
          platform: 'youtube',
          platform_id: v.id,
          content_type: isShort ? 'SHORT' : 'VIDEO',
          title: v.snippet.title,
          caption: v.snippet.description || null,
          url: `https://www.youtube.com/watch?v=${v.id}`,
          thumbnail_url: v.snippet.thumbnails?.high?.url || v.snippet.thumbnails?.default?.url || null,
          duration_seconds: seconds,
          published_at: new Date(v.snippet.publishedAt).toISOString(),
          // Simpan statistik dasar di sini — akan digunakan oleh sync engine untuk snapshot
          _stats: {
            views: nullify(v.statistics?.viewCount ? parseInt(v.statistics.viewCount) : null),
            likes: nullify(v.statistics?.likeCount ? parseInt(v.statistics.likeCount) : null),
            comments: nullify(v.statistics?.commentCount ? parseInt(v.statistics.commentCount) : null)
          }
        });
      }
    }

    return contents;
  },

  // Cache batch analytics per sync cycle
  _analyticsCache: {},

  async _fetchBatchAnalytics(token) {
    try {
      const today = new Date();
      const endDate = new Date(today); endDate.setDate(endDate.getDate() - 2);
      const fmt = d => d.toISOString().split('T')[0];
      const metrics = 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,likes,comments,shares';
      const url = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&dimensions=video&metrics=${metrics}&startDate=2026-06-01&endDate=${fmt(endDate)}&maxResults=200&sort=-views&access_token=${token}`;
      
      const r = await apiGet(url);
      if (r.status === 200 && Array.isArray(r.data.rows)) {
        const cols = r.data.columnHeaders.map(c => c.name);
        const map = {};
        for (const row of r.data.rows) {
          const videoId = row[0];
          const entry = {};
          cols.forEach((col, idx) => { entry[col] = row[idx]; });
          map[videoId] = entry;
        }
        this._analyticsCache = map;
      }
    } catch (err) {
      console.warn('[YouTube] Batch analytics fetch warning:', err.message);
    }
  },

  async getContentMetrics(videoId) {
    const token = await getAccessToken('youtube');

    // Data API (lifetime stats)
    const r = await apiGet(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoId}&access_token=${token}`);
    const stats = r.data?.items?.[0]?.statistics || {};

    // Check preloaded analytics cache or fetch single video
    let analyticsData = this._analyticsCache[videoId];
    if (!analyticsData) {
      const today = new Date();
      const endDate = new Date(today); endDate.setDate(endDate.getDate() - 2);
      const fmt = d => d.toISOString().split('T')[0];

      try {
        const analyticsMetrics = 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained';
        const ar = await apiGet(
          `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&filters=video==${videoId}&dimensions=video&metrics=${analyticsMetrics}&startDate=2026-06-01&endDate=${fmt(endDate)}&access_token=${token}`
        );
        if (ar.status === 200 && Array.isArray(ar.data.rows) && ar.data.rows.length > 0) {
          const cols = ar.data.columnHeaders.map(c => c.name);
          const row = ar.data.rows[0];
          analyticsData = {};
          cols.forEach((col, i) => { analyticsData[col] = row[i]; });
        }
      } catch {}
    }

    analyticsData = analyticsData || {};

    return {
      views:       nullify(stats.viewCount ? parseInt(stats.viewCount) : analyticsData.views),
      likes:       nullify(stats.likeCount ? parseInt(stats.likeCount) : analyticsData.likes),
      comments:    nullify(stats.commentCount ? parseInt(stats.commentCount) : analyticsData.comments),
      shares:      nullify(analyticsData.shares),
      saves:       null,  // Tidak tersedia via API standard
      reach:       null,
      impressions: null,
      estimated_minutes_watched: nullify(analyticsData.estimatedMinutesWatched ? Math.round(analyticsData.estimatedMinutesWatched) : null),
      average_view_duration:     nullify(analyticsData.averageViewDuration ? Math.round(analyticsData.averageViewDuration) : null),
      average_view_percentage:   nullify(analyticsData.averageViewPercentage),
      subscribers_gained:        nullify(analyticsData.subscribersGained),
      subscribers_lost:          nullify(analyticsData.subscribersLost)
    };
  },

  async getAccountMetrics() {
    const token = await getAccessToken('youtube');

    const r = await apiGet(`https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true&access_token=${token}`);
    if (r.status !== 200 || !r.data.items?.length) return null;

    const s = r.data.items[0].statistics;
    return {
      followers: null,
      following: null,
      subscribers: nullify(s.subscriberCount ? parseInt(s.subscriberCount) : null),
      total_views: nullify(s.viewCount ? parseInt(s.viewCount) : null)
    };
  },

  async getComments(videoId, limit = 50) {
    const token = await getAccessToken('youtube');

    let url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=${Math.min(limit, 100)}&access_token=${token}`;
    const comments = [];

    while (url && comments.length < limit) {
      const { status, data } = await apiGet(url);
      if (status !== 200 || !Array.isArray(data.items)) break;

      for (const item of data.items) {
        const top = item.snippet.topLevelComment.snippet;
        comments.push({
          platform_comment_id: item.snippet.topLevelComment.id,
          author_name: top.authorDisplayName,
          author_id: top.authorChannelId?.value || null,
          text: top.textOriginal,
          like_count: top.likeCount || 0,
          published_at: new Date(top.publishedAt).toISOString(),
          parent_comment_id: null
        });
      }
      url = data.nextPageToken
        ? `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=100&pageToken=${data.nextPageToken}&access_token=${token}`
        : null;
    }

    return comments;
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// STUB ADAPTERS (out of scope, disiapkan untuk masa depan)
// ══════════════════════════════════════════════════════════════════════════════
const tiktokAdapter = {
  platform: 'tiktok',
  async listContents() { throw new Error('TikTok adapter not implemented (out of scope)'); },
  async getContentMetrics() { throw new Error('TikTok adapter not implemented'); },
  async getAccountMetrics() { throw new Error('TikTok adapter not implemented'); },
  async getComments() { throw new Error('TikTok adapter not implemented'); }
};

const facebookAdapter = {
  platform: 'facebook',
  async listContents() { throw new Error('Facebook Pages adapter not implemented (out of scope)'); },
  async getContentMetrics() { throw new Error('Facebook Pages adapter not implemented'); },
  async getAccountMetrics() { throw new Error('Facebook Pages adapter not implemented'); },
  async getComments() { throw new Error('Facebook Pages adapter not implemented'); }
};

// ── Registry ──────────────────────────────────────────────────────────────────
const ADAPTERS = {
  instagram: instagramAdapter,
  threads:   threadsAdapter,
  youtube:   youtubeAdapter,
  tiktok:    tiktokAdapter,
  facebook:  facebookAdapter
};

function getAdapter(platform) {
  const adapter = ADAPTERS[platform];
  if (!adapter) throw new Error(`Unknown platform: ${platform}`);
  return adapter;
}

module.exports = { getAdapter, ADAPTERS };
