/**
 * Token Manager — auto-refresh per brief Section 5.5
 * 
 * Aturan:
 * - Instagram / Threads: long-lived token ~60 hari.
 *   Cek tiap hari, refresh jika sisa < 15 hari DAN token sudah berumur > 24 jam.
 *   Jika expired dan tidak bisa refresh → escalate (alert webhook).
 * - YouTube: gunakan refresh_token untuk mendapatkan access_token baru setiap run.
 *   Cache access_token selama masih valid. Simpan di memori saja (tidak perlu DB).
 * 
 * Token TIDAK PERNAH dikembalikan via fungsi publik yang dipanggil dari API layer.
 */

require('dotenv').config();
const https = require('https');
const { getToken, upsertToken, markTokenError } = require('../db/database');

// ── YouTube access token cache (in-memory only) ───────────────────────────────
let _ytCachedToken = null;
let _ytTokenExpiresAt = null;

// ── HTTP POST helper ──────────────────────────────────────────────────────────
function httpsPost(url, payload) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams(payload).toString();
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(params)
      }
    }, (res) => {
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

// ── Alert / Escalation ────────────────────────────────────────────────────────
async function sendAlert(message) {
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  console.warn(`[TokenManager][ALERT] ${message}`);

  if (!webhookUrl) return; // No webhook configured — log only

  try {
    const urlObj = new URL(webhookUrl);
    const payload = JSON.stringify({ text: `[Asistent Creator] ${message}` });
    await new Promise((resolve) => {
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      }, resolve);
      req.on('error', () => {});
      req.write(payload);
      req.end();
    });
  } catch {}
}

// ── Days remaining until ISO date ─────────────────────────────────────────────
function daysUntil(isoDate) {
  if (!isoDate) return Infinity;
  return Math.floor((new Date(isoDate) - new Date()) / (1000 * 60 * 60 * 24));
}

// ── Hours since ISO date ──────────────────────────────────────────────────────
function hoursSince(isoDate) {
  if (!isoDate) return Infinity;
  return (new Date() - new Date(isoDate)) / (1000 * 60 * 60);
}

// ── Bootstrap: seed tokens dari .env ke DB jika belum ada ────────────────────
function bootstrapTokensFromEnv() {
  const platforms = [
    {
      platform: 'instagram',
      envKey: 'IG_ACCESS_TOKEN',
      type: 'long_lived',
      // Long-lived token berlaku 60 hari dari sekarang (estimasi — akan diperbarui saat refresh)
      expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
    },
    {
      platform: 'threads',
      envKey: 'THREADS_ACCESS_TOKEN',
      type: 'long_lived',
      expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
    },
    {
      platform: 'youtube',
      envKey: 'YT_REFRESH_TOKEN',
      type: 'oauth2',
      expiresAt: null  // refresh_token tidak expired selama app In Production
    }
  ];

  for (const { platform, envKey, type, expiresAt } of platforms) {
    const envValue = process.env[envKey];
    if (!envValue) {
      console.warn(`[TokenManager] ${envKey} not set in .env — skipping ${platform}`);
      continue;
    }
    const existing = getToken(platform);
    if (!existing) {
      upsertToken(platform, {
        access_token: envValue,
        token_type: type,
        expires_at: expiresAt
      });
      console.log(`[TokenManager] Bootstrapped token for ${platform} from env`);
    }
  }
}

// ── Instagram / Threads: refresh long-lived token ────────────────────────────
async function refreshMetaToken(platform) {
  const state = getToken(platform);
  if (!state) throw new Error(`No token found for ${platform}`);

  const refreshUrl = platform === 'instagram'
    ? 'https://graph.instagram.com/refresh_access_token'
    : 'https://graph.threads.net/refresh_access_token';

  const url = `${refreshUrl}?grant_type=ig_refresh_token&access_token=${state.access_token}`;

  const result = await new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    }).on('error', reject);
  });

  if (result.status === 200 && result.data.access_token) {
    const expiresIn = result.data.expires_in || (60 * 24 * 60 * 60); // default 60 days in seconds
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    upsertToken(platform, {
      access_token: result.data.access_token,
      token_type: 'long_lived',
      expires_at: expiresAt
    });
    console.log(`[TokenManager] ${platform} token refreshed. Expires: ${expiresAt}`);
    return result.data.access_token;
  } else {
    const errMsg = result.data?.error?.message || JSON.stringify(result.data);
    markTokenError(platform, errMsg);
    await sendAlert(`PERINGATAN: Token ${platform} gagal refresh! Error: ${errMsg}. Diperlukan re-auth manual.`);
    throw new Error(`Failed to refresh ${platform} token: ${errMsg}`);
  }
}

// ── YouTube: dapatkan access token via refresh_token ─────────────────────────
async function getYouTubeAccessToken() {
  // Gunakan cached token jika masih valid (dengan buffer 5 menit)
  if (_ytCachedToken && _ytTokenExpiresAt && new Date() < new Date(_ytTokenExpiresAt.getTime() - 5 * 60 * 1000)) {
    return _ytCachedToken;
  }

  const clientId = process.env.YT_CLIENT_ID;
  const clientSecret = process.env.YT_CLIENT_SECRET;
  const refreshToken = process.env.YT_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('YouTube credentials (YT_CLIENT_ID/YT_CLIENT_SECRET/YT_REFRESH_TOKEN) not set in .env');
  }

  const result = await httpsPost('https://oauth2.googleapis.com/token', {
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken
  });

  if (result.status === 200 && result.data.access_token) {
    _ytCachedToken = result.data.access_token;
    _ytTokenExpiresAt = new Date(Date.now() + (result.data.expires_in - 60) * 1000); // -60s buffer
    console.log(`[TokenManager] YouTube access token obtained (valid for ${result.data.expires_in}s)`);
    return _ytCachedToken;
  } else {
    const errMsg = result.data?.error_description || result.data?.error || JSON.stringify(result.data);
    await sendAlert(`PERINGATAN: YouTube access token gagal didapatkan! Error: ${errMsg}`);
    throw new Error(`Failed to get YouTube access token: ${errMsg}`);
  }
}

// ── Dapatkan access token untuk platform (dipakai oleh adapters) ─────────────
// CATATAN: Fungsi ini mengembalikan token ke dalam proses server (bukan ke API response)
async function getAccessToken(platform) {
  if (platform === 'youtube') {
    return getYouTubeAccessToken();
  }

  let state = getToken(platform);
  if (!state) {
    bootstrapTokensFromEnv();
    state = getToken(platform);
  }

  if (state && state.access_token) {
    if (state.status === 'expired') throw new Error(`Token for ${platform} is expired. Re-auth required.`);
    return state.access_token;
  }

  const envKey = platform === 'instagram' ? 'IG_ACCESS_TOKEN' : 'THREADS_ACCESS_TOKEN';
  const envToken = process.env[envKey];
  if (envToken) return envToken;

  throw new Error(`Token for ${platform} not found. Please check .env`);
}

// ── Cek dan refresh token yang mendekati expired (dipanggil tiap hari oleh scheduler) ──
async function checkAndRefreshTokens() {
  console.log('[TokenManager] Running daily token check...');

  for (const platform of ['instagram', 'threads']) {
    const state = getToken(platform);
    if (!state) {
      console.warn(`[TokenManager] No token in DB for ${platform}`);
      continue;
    }

    const remaining = daysUntil(state.expires_at);
    const ageSinceRefresh = hoursSince(state.last_refreshed_at || state.created_at);

    console.log(`[TokenManager] ${platform}: ${remaining} days remaining, refreshed ${Math.round(ageSinceRefresh)}h ago`);

    if (remaining <= 0) {
      markTokenError(platform, 'Token expired');
      await sendAlert(`DARURAT: Token ${platform} SUDAH EXPIRED! Harus re-auth manual segera.`);
      continue;
    }

    if (remaining <= 5) {
      await sendAlert(`PERINGATAN KRITIS: Token ${platform} akan expired dalam ${remaining} hari!`);
    }

    // Refresh jika < 15 hari tersisa DAN token sudah berumur > 24 jam
    if (remaining < 15 && ageSinceRefresh >= 24) {
      console.log(`[TokenManager] Refreshing ${platform} token (${remaining} days remaining)...`);
      try {
        await refreshMetaToken(platform);
      } catch (e) {
        console.error(`[TokenManager] Refresh failed for ${platform}: ${e.message}`);
      }
    }
  }

  // YouTube: test apakah bisa mendapatkan access token
  try {
    await getYouTubeAccessToken();
    console.log('[TokenManager] YouTube token: OK');
  } catch (e) {
    console.error(`[TokenManager] YouTube token check failed: ${e.message}`);
  }
}

module.exports = {
  bootstrapTokensFromEnv,
  getAccessToken,
  getYouTubeAccessToken,
  checkAndRefreshTokens
};
