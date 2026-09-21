/**
 * API Verification Script — Section 2 of Brief
 * 
 * Menguji semua endpoint API resmi Instagram, Threads, dan YouTube.
 * TIDAK menampilkan token di output manapun.
 * Hanya melaporkan capability map dan hasil uji.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const https = require('https');

// ── Redaction helper ──────────────────────────────────────────────────────────
function redactToken(url) {
  return url
    .replace(/access_token=[^&]*/gi, 'access_token=[REDACTED]')
    .replace(/IGC?[A-Za-z0-9_-]{40,}/g, '[REDACTED]')
    .replace(/TH[A-Za-z0-9_-]{40,}/g, '[REDACTED]');
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, data: body });
        }
      });
    }).on('error', reject);
  });
}

function post(url, payload) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams(payload).toString();
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(params) }
    };
    const urlObj = new URL(url);
    opts.hostname = urlObj.hostname;
    opts.path = urlObj.pathname;
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    req.write(params);
    req.end();
  });
}

// ── Result collector ──────────────────────────────────────────────────────────
const results = {
  instagram: { ok: false, profile: null, media: [], insights: {}, errors: [] },
  threads:   { ok: false, profile: null, posts: [], insights: {}, errors: [] },
  youtube:   { ok: false, channel: null, videos: [], analytics: {}, errors: [] },
  capabilityMap: {}
};

function log(section, msg) {
  console.log(`[${section}] ${msg}`);
}

function err(section, msg) {
  console.error(`[${section}][ERROR] ${msg}`);
  results[section]?.errors?.push(msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2.1 INSTAGRAM
// ─────────────────────────────────────────────────────────────────────────────
async function verifyInstagram() {
  log('Instagram', 'Starting verification...');
  const token = process.env.IG_ACCESS_TOKEN;
  if (!token) { err('instagram', 'IG_ACCESS_TOKEN not set in .env'); return; }

  const base = 'https://graph.instagram.com/v23.0';

  // Profile
  try {
    const r = await get(`${base}/me?fields=id,username,followers_count,media_count&access_token=${token}`);
    if (r.status === 200 && r.data.id) {
      results.instagram.profile = { id: r.data.id, username: r.data.username, followers: r.data.followers_count, media_count: r.data.media_count };
      results.instagram.ok = true;
      log('Instagram', `Profile OK — @${r.data.username} | Followers: ${r.data.followers_count} | Media: ${r.data.media_count}`);
    } else {
      err('instagram', `Profile failed: ${r.status} — ${JSON.stringify(r.data?.error || r.data)}`);
      return;
    }
  } catch (e) { err('instagram', `Profile exception: ${e.message}`); return; }

  // Media list
  try {
    const r = await get(`${base}/me/media?fields=id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url&limit=10&access_token=${token}`);
    if (r.status === 200 && Array.isArray(r.data.data)) {
      results.instagram.media = r.data.data;
      log('Instagram', `Media list OK — ${r.data.data.length} items found`);
      r.data.data.slice(0, 5).forEach(m => {
        log('Instagram', `  • [${m.media_product_type || m.media_type}] ${m.id} — ${(m.caption || '').substring(0, 60).replace(/\n/g, ' ')}`);
      });
    } else {
      err('instagram', `Media list failed: ${r.status} — ${JSON.stringify(r.data?.error || r.data)}`);
    }
  } catch (e) { err('instagram', `Media list exception: ${e.message}`); }

  // Insights per media type
  const testedTypes = {};
  const candidateMetrics = ['views', 'reach', 'saved', 'shares', 'likes', 'comments', 'total_interactions', 'impressions'];
  
  for (const media of results.instagram.media.slice(0, 10)) {
    const type = media.media_product_type || media.media_type;
    if (testedTypes[type]) continue;
    testedTypes[type] = true;

    log('Instagram', `Testing insights for type: ${type} (id: ${media.id})`);
    const availableMetrics = [];

    for (const metric of candidateMetrics) {
      try {
        const r = await get(`${base}/${media.id}/insights?metric=${metric}&access_token=${token}`);
        if (r.status === 200 && r.data.data) {
          availableMetrics.push(metric);
        }
      } catch {}
    }

    // Try batch
    if (availableMetrics.length === 0) {
      // Try all at once
      const r = await get(`${base}/${media.id}/insights?metric=${candidateMetrics.join(',')}&access_token=${token}`).catch(() => null);
      if (r?.status === 200 && r.data.data) {
        r.data.data.forEach(d => availableMetrics.push(d.name));
      }
    }

    results.instagram.insights[type] = availableMetrics;
    log('Instagram', `  Available metrics for ${type}: [${availableMetrics.join(', ') || 'none'}]`);
  }

  // Capability map
  results.capabilityMap.instagram = results.instagram.insights;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2.2 THREADS
// ─────────────────────────────────────────────────────────────────────────────
async function verifyThreads() {
  log('Threads', 'Starting verification...');
  const token = process.env.THREADS_ACCESS_TOKEN;
  if (!token) { err('threads', 'THREADS_ACCESS_TOKEN not set in .env'); return; }

  const base = 'https://graph.threads.net/v1.0';

  // Profile
  try {
    const r = await get(`${base}/me?fields=id,username&access_token=${token}`);
    if (r.status === 200 && r.data.id) {
      results.threads.profile = { id: r.data.id, username: r.data.username };
      results.threads.ok = true;
      log('Threads', `Profile OK — @${r.data.username}`);
    } else {
      err('threads', `Profile failed: ${r.status} — ${JSON.stringify(r.data?.error || r.data)}`);
      return;
    }
  } catch (e) { err('threads', `Profile exception: ${e.message}`); return; }

  // Posts list
  try {
    const r = await get(`${base}/me/threads?fields=id,text,media_type,permalink,timestamp&limit=10&access_token=${token}`);
    if (r.status === 200 && Array.isArray(r.data.data)) {
      results.threads.posts = r.data.data;
      log('Threads', `Posts list OK — ${r.data.data.length} posts`);
    } else {
      err('threads', `Posts list failed: ${r.status} — ${JSON.stringify(r.data?.error || r.data)}`);
    }
  } catch (e) { err('threads', `Posts list exception: ${e.message}`); }

  // Post insights
  if (results.threads.posts.length > 0) {
    const post = results.threads.posts[0];
    const candidateMetrics = ['views', 'likes', 'replies', 'reposts', 'quotes', 'shares'];
    log('Threads', `Testing post insights for: ${post.id}`);
    try {
      const r = await get(`${base}/${post.id}/insights?metric=${candidateMetrics.join(',')}&access_token=${token}`);
      if (r.status === 200 && r.data.data) {
        const available = r.data.data.map(d => d.name);
        results.threads.insights['text_post'] = available;
        log('Threads', `  Post insights available: [${available.join(', ')}]`);
      } else {
        // Try individually
        const available = [];
        for (const m of candidateMetrics) {
          const ri = await get(`${base}/${post.id}/insights?metric=${m}&access_token=${token}`).catch(() => null);
          if (ri?.status === 200 && ri.data.data) available.push(m);
        }
        results.threads.insights['text_post'] = available;
        log('Threads', `  Post insights (individual): [${available.join(', ') || 'none'}]`);
      }
    } catch (e) { err('threads', `Post insights exception: ${e.message}`); }
  }

  // Account insights
  try {
    const metrics = 'views,likes,replies,reposts,quotes,followers_count';
    const r = await get(`${base}/me/threads_insights?metric=${metrics}&access_token=${token}`);
    if (r.status === 200) {
      const available = Array.isArray(r.data.data) ? r.data.data.map(d => d.name) : [];
      results.threads.insights['account'] = available;
      log('Threads', `  Account insights available: [${available.join(', ') || 'check data'}]`);
    } else {
      log('Threads', `  Account insights: ${r.status} — ${JSON.stringify(r.data?.error || r.data).substring(0, 150)}`);
    }
  } catch (e) { err('threads', `Account insights exception: ${e.message}`); }

  results.capabilityMap.threads = results.threads.insights;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2.3 YOUTUBE
// ─────────────────────────────────────────────────────────────────────────────
async function verifyYouTube() {
  log('YouTube', 'Starting verification...');

  const clientId = process.env.YT_CLIENT_ID;
  const clientSecret = process.env.YT_CLIENT_SECRET;
  const refreshToken = process.env.YT_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    err('youtube', 'YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN not set in .env');
    return;
  }

  // Get access token
  let accessToken;
  try {
    const r = await post('https://oauth2.googleapis.com/token', {
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken
    });
    if (r.status === 200 && r.data.access_token) {
      accessToken = r.data.access_token;
      log('YouTube', `Access token obtained OK (expires in ${r.data.expires_in}s)`);
    } else {
      err('youtube', `Token exchange failed: ${r.status} — ${JSON.stringify(r.data)}`);
      return;
    }
  } catch (e) { err('youtube', `Token exchange exception: ${e.message}`); return; }

  // Channel info
  let uploadsPlaylistId;
  try {
    const r = await get(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true&access_token=${accessToken}`);
    if (r.status === 200 && r.data.items?.length > 0) {
      const ch = r.data.items[0];
      results.youtube.channel = {
        id: ch.id,
        title: ch.snippet.title,
        subscribers: ch.statistics.subscriberCount,
        views: ch.statistics.viewCount,
        videoCount: ch.statistics.videoCount
      };
      uploadsPlaylistId = ch.contentDetails?.relatedPlaylists?.uploads;
      results.youtube.ok = true;
      log('YouTube', `Channel OK — "${ch.snippet.title}" | Subs: ${ch.statistics.subscriberCount} | Videos: ${ch.statistics.videoCount}`);
      log('YouTube', `Uploads playlist: ${uploadsPlaylistId}`);
    } else {
      err('youtube', `Channel failed: ${r.status} — ${JSON.stringify(r.data?.error || r.data)}`);
      return;
    }
  } catch (e) { err('youtube', `Channel exception: ${e.message}`); return; }

  // Playlist items (video list)
  let videoIds = [];
  try {
    const r = await get(`https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${uploadsPlaylistId}&maxResults=5&access_token=${accessToken}`);
    if (r.status === 200 && Array.isArray(r.data.items)) {
      videoIds = r.data.items.map(i => i.contentDetails.videoId);
      log('YouTube', `PlaylistItems OK — ${r.data.items.length} videos (sample): ${videoIds.join(', ')}`);
    } else {
      err('youtube', `PlaylistItems failed: ${r.status} — ${JSON.stringify(r.data?.error)}`);
    }
  } catch (e) { err('youtube', `PlaylistItems exception: ${e.message}`); }

  // Video details
  if (videoIds.length > 0) {
    try {
      const r = await get(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoIds.slice(0, 3).join(',')}&access_token=${accessToken}`);
      if (r.status === 200 && Array.isArray(r.data.items)) {
        results.youtube.videos = r.data.items.map(v => ({
          id: v.id,
          title: v.snippet.title,
          views: v.statistics.viewCount,
          likes: v.statistics.likeCount,
          comments: v.statistics.commentCount,
          duration: v.contentDetails.duration
        }));
        log('YouTube', `Video details OK — ${r.data.items.length} videos fetched`);
        r.data.items.slice(0, 3).forEach(v => {
          log('YouTube', `  • "${v.snippet.title}" | Views: ${v.statistics.viewCount}`);
        });
        results.youtube.insights['video'] = ['views', 'likes', 'comments', 'duration', 'thumbnail'];
      } else {
        err('youtube', `Videos failed: ${r.status} — ${JSON.stringify(r.data?.error)}`);
      }
    } catch (e) { err('youtube', `Videos exception: ${e.message}`); }
  }

  // YouTube Analytics
  const today = new Date();
  const endDate = new Date(today); endDate.setDate(endDate.getDate() - 2);
  const startDate = new Date(endDate); startDate.setDate(startDate.getDate() - 30);
  const fmt = d => d.toISOString().split('T')[0];

  try {
    const analyticsMetrics = 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained';
    const r = await get(`https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&dimensions=video&metrics=${analyticsMetrics}&startDate=${fmt(startDate)}&endDate=${fmt(endDate)}&sort=-views&maxResults=10&access_token=${accessToken}`);
    if (r.status === 200 && r.data.rows) {
      log('YouTube', `Analytics OK — ${r.data.rows.length} video rows returned`);
      const cols = (r.data.columnHeaders || []).map(c => c.name);
      log('YouTube', `  Analytics columns: [${cols.join(', ')}]`);
      results.youtube.analytics = { columns: cols, sampleRows: r.data.rows.length };
      results.youtube.insights['analytics'] = cols.filter(c => c !== 'video');
    } else {
      err('youtube', `Analytics failed: ${r.status} — ${JSON.stringify(r.data?.error || r.data).substring(0, 200)}`);
    }
  } catch (e) { err('youtube', `Analytics exception: ${e.message}`); }

  // Test CTR/Impressions (may not be available)
  try {
    const r = await get(`https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&dimensions=video&metrics=cardImpressions,cardClickRate&startDate=${fmt(startDate)}&endDate=${fmt(endDate)}&maxResults=5&access_token=${accessToken}`);
    if (r.status === 200 && r.data.rows) {
      log('YouTube', `  CTR/Impressions: AVAILABLE`);
      results.youtube.insights['analytics_ctr'] = ['cardImpressions', 'cardClickRate'];
    } else {
      log('YouTube', `  CTR/Impressions via Analytics: NOT AVAILABLE (${r.status})`);
      results.youtube.insights['analytics_ctr'] = [];
    }
  } catch { log('YouTube', '  CTR/Impressions: NOT AVAILABLE (exception)'); }

  results.capabilityMap.youtube = results.youtube.insights;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('   API VERIFICATION — Asistent Creator (Section 2)');
  console.log('══════════════════════════════════════════════════════\n');

  await verifyInstagram();
  console.log('');
  await verifyThreads();
  console.log('');
  await verifyYouTube();

  console.log('\n══════════════════════════════════════════════════════');
  console.log('   VERIFICATION SUMMARY');
  console.log('══════════════════════════════════════════════════════');
  console.log(`Instagram : ${results.instagram.ok ? 'OK' : 'FAILED'} | Profile: @${results.instagram.profile?.username || 'N/A'}`);
  console.log(`Threads   : ${results.threads.ok ? 'OK' : 'FAILED'} | Profile: @${results.threads.profile?.username || 'N/A'}`);
  console.log(`YouTube   : ${results.youtube.ok ? 'OK' : 'FAILED'} | Channel: "${results.youtube.channel?.title || 'N/A'}"`);

  console.log('\n── CAPABILITY MAP ────────────────────────────────────');
  console.log(JSON.stringify(results.capabilityMap, null, 2));

  if (results.instagram.errors.length > 0) console.log('\nInstagram Errors:', results.instagram.errors);
  if (results.threads.errors.length > 0) console.log('Threads Errors:', results.threads.errors);
  if (results.youtube.errors.length > 0) console.log('YouTube Errors:', results.youtube.errors);

  console.log('\n══════════════════════════════════════════════════════\n');
}

main().catch(e => console.error('Fatal:', e.message));
