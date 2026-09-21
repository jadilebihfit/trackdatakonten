/**
 * app.js — Frontend Dashboard Logic
 * 
 * Memanggil API internal (/api/*) yang terhubung ke data real.
 * Fitur:
 *   - Semua metrik bernilai numerik rapi (0 jika tidak ada, bukan "n/a")
 *   - Perhitungan otomatis Engagement Rate di seluruh tabel
 *   - Time Frame Selector:
 *       • Hari Ini (Today)
 *       • Kemarin (Yesterday)
 *       • 7 Hari, 28 Hari, 90 Hari, 365 Hari, Lifetime
 *       • Kustom Rentang Tanggal (Date Picker Dari - Sampai)
 *   - Modal YouTube Studio & Platform Detail interaktif
 */

let trendChartInstance = null;
let compositionChartInstance = null;
let activeModalPlatform = null;

// ── Helper: format angka (0 jika null/kosong) ─────────────────────────────────
function fmt(val, decimals = 0) {
  if (val === null || val === undefined) return '0';
  const n = Number(val);
  if (isNaN(n)) return '0';
  return decimals > 0 ? n.toFixed(decimals) : n.toLocaleString('id-ID');
}

// ── Helper: singkat angka besar (1.2K, 3.4M, 0 jika kosong) ───────────────────
function shortNum(val) {
  if (val === null || val === undefined) return '0';
  const n = Number(val);
  if (isNaN(n) || n === 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString('id-ID');
}

// ── Helper: hitung engagement rate (%) ────────────────────────────────────────
function calcEngRate(views, likes, comments, saves, shares) {
  const v = Number(views) || 0;
  if (v <= 0) return '0.0%';
  const interactions = (Number(likes) || 0) + (Number(comments) || 0) + (Number(saves) || 0) + (Number(shares) || 0);
  return (interactions / v * 100).toFixed(1) + '%';
}

// ── Helper: tanggal relatif ────────────────────────────────────────────────────
function relativeDate(iso) {
  if (!iso) return '';
  const diff = Math.floor((Date.now() - new Date(iso)) / (1000 * 60 * 60 * 24));
  if (diff === 0) return 'Hari ini';
  if (diff === 1) return '1 hari lalu';
  if (diff < 30) return `${diff} hari lalu`;
  if (diff < 365) return `${Math.floor(diff / 30)} bulan lalu`;
  return `${Math.floor(diff / 365)} tahun lalu`;
}

// ── Helper: format waktu tonton (menit → "Xj Ym" atau "Xm") ───────────────────
function fmtWatchTime(minutes) {
  if (minutes === null || minutes === undefined) return '0m';
  const m = Math.round(Number(minutes));
  if (isNaN(m) || m === 0) return '0m';
  if (m >= 60) return `${Math.floor(m / 60)}j ${m % 60}m`;
  return `${m}m`;
}

// ── Helper: format durasi (detik → "M:SS") ───────────────────────────────────
function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return '';
  const s = Math.round(Number(seconds));
  if (isNaN(s)) return '';
  if (s >= 60) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return `0:${String(s).padStart(2, '0')}`;
}

// ── Platform badge HTML ────────────────────────────────────────────────────────
const PLATFORM_BADGE = {
  youtube:   `<span class="px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider bg-white/10 text-white rounded-full border border-white/10"><i class="fa-brands fa-youtube mr-1"></i>YouTube</span>`,
  instagram: `<span class="px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider bg-white/10 text-white rounded-full border border-white/10"><i class="fa-brands fa-instagram mr-1"></i>Instagram</span>`,
  threads:   `<span class="px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider bg-white/10 text-white rounded-full border border-white/10"><i class="fa-solid fa-at mr-1"></i>Threads</span>`
};

const PLATFORM_ICON = {
  youtube: 'fa-brands fa-youtube',
  instagram: 'fa-brands fa-instagram',
  threads: 'fa-solid fa-at'
};

// ── Time Frame State & Calculations ───────────────────────────────────────────
let currentTimeframe = '28d';
let currentRange = { from: '', to: '' };

function calculateDateRange(timeframe) {
  const to = new Date();
  const from = new Date(to);

  if (timeframe === 'today' || timeframe === '1d') {
    // Single day: today
    return {
      to: to.toISOString().split('T')[0],
      from: to.toISOString().split('T')[0]
    };
  } else if (timeframe === 'yesterday') {
    from.setDate(from.getDate() - 1);
    const yesterdayStr = from.toISOString().split('T')[0];
    return { to: yesterdayStr, from: yesterdayStr };
  } else if (timeframe === '7d') {
    from.setDate(from.getDate() - 7);
  } else if (timeframe === '28d') {
    from.setDate(from.getDate() - 28);
  } else if (timeframe === '90d') {
    from.setDate(from.getDate() - 90);
  } else if (timeframe === '365d') {
    from.setDate(from.getDate() - 365);
  } else if (timeframe === 'all' || timeframe === 'lifetime') {
    return {
      to: to.toISOString().split('T')[0],
      from: '2020-01-01'
    };
  } else {
    from.setDate(from.getDate() - 28);
  }

  return {
    to: to.toISOString().split('T')[0],
    from: from.toISOString().split('T')[0]
  };
}

// ════════════════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  currentRange = calculateDateRange(currentTimeframe);
  initDashboard();
});

async function initDashboard() {
  showGlobalLoading(true);
  try {
    await Promise.all([
      loadOverview(),
      loadSyncStatus()
    ]);
  } finally {
    showGlobalLoading(false);
  }
}

function showGlobalLoading(on) {
  const el = document.getElementById('global-loading');
  if (el) el.classList.toggle('hidden', !on);
}

// ── Timeframe Change Handler (Overview Tab) ───────────────────────────────────
async function onTimeframeChange(newTf) {
  currentTimeframe = newTf;
  const customContainer = document.getElementById('custom-date-container');

  if (newTf === 'custom') {
    if (customContainer) {
      customContainer.classList.remove('hidden');
      const today = new Date().toISOString().split('T')[0];
      const from28 = new Date();
      from28.setDate(from28.getDate() - 28);
      const fromStr = from28.toISOString().split('T')[0];
      
      const elFrom = document.getElementById('custom-date-from');
      const elTo = document.getElementById('custom-date-to');
      if (elFrom && !elFrom.value) elFrom.value = fromStr;
      if (elTo && !elTo.value) elTo.value = today;
    }
    return;
  }

  if (customContainer) customContainer.classList.add('hidden');
  currentRange = calculateDateRange(newTf);
  await loadOverview();
}

async function applyCustomDateRange() {
  const elFrom = document.getElementById('custom-date-from');
  const elTo = document.getElementById('custom-date-to');
  const from = elFrom?.value;
  const to = elTo?.value;

  if (!from || !to) {
    alert('Silakan pilih tanggal awal dan akhir.');
    return;
  }

  currentRange = { from, to };
  currentTimeframe = 'custom';
  await loadOverview();
}

// ════════════════════════════════════════════════════════════════════════════
// Tab Switcher
// ════════════════════════════════════════════════════════════════════════════
function switchTab(tabId) {
  const tabs = ['overview', 'contents'];
  tabs.forEach(t => {
    const el = document.getElementById(`tab-${t}`);
    const nav = document.getElementById(`nav-${t}`);
    if (el) el.classList.add('hidden');
    if (nav) {
      nav.classList.remove('active', 'text-white', 'bg-white/10', 'border-white/15', 'font-semibold');
      nav.classList.add('text-slate-400');
    }
  });

  const activeTab = document.getElementById(`tab-${tabId}`);
  const activeNav = document.getElementById(`nav-${tabId}`);
  if (activeTab) activeTab.classList.remove('hidden');
  if (activeNav) {
    activeNav.classList.add('active', 'text-white', 'bg-white/10', 'border-white/15', 'font-semibold');
    activeNav.classList.remove('text-slate-400');
  }

  if (tabId === 'contents') {
    contentsPage = 1;
    loadContentsTable();
  }
}

function loadVideosTable() { applyFilters(); }

// ════════════════════════════════════════════════════════════════════════════
// 1. Load Overview (KPI + Channel Cards + Charts + Top Content)
// ════════════════════════════════════════════════════════════════════════════
async function loadOverview() {
  try {
    const params = new URLSearchParams({ from: currentRange.from, to: currentRange.to });
    const res = await fetch(`/api/overview?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    renderKPICards(json.platforms || []);
    renderChannelCards(json.accounts || []);
    renderTrendChart(json.trend || []);
    renderTopContent(json.topContent || []);
    renderDataWarnings(json.dataWarnings);
  } catch (err) {
    console.error('[Dashboard] loadOverview error:', err);
    showOverviewError(err.message);
  }
}

// ── KPI Cards ─────────────────────────────────────────────────────────────────
function renderKPICards(platforms) {
  let totalViews = 0, totalSaves = 0, totalShares = 0, totalLikes = 0, totalComments = 0;

  for (const p of platforms) {
    if (p.total_views !== null) totalViews += Number(p.total_views);
    if (p.total_saves !== null) totalSaves += Number(p.total_saves);
    if (p.total_shares !== null) totalShares += Number(p.total_shares);
    if (p.total_likes !== null) totalLikes += Number(p.total_likes);
    if (p.total_comments !== null) totalComments += Number(p.total_comments);
  }

  const totalInteractions = totalLikes + totalComments + totalSaves + totalShares;
  const engRate = totalViews > 0 ? (totalInteractions / totalViews * 100).toFixed(1) : '0.0';

  setText('stat-views', shortNum(totalViews));
  setText('stat-saves', shortNum(totalSaves));
  setText('stat-shares', shortNum(totalShares));
  setText('stat-likes-comments', shortNum(totalInteractions));
  setText('stat-comments-breakdown', `${fmt(totalLikes)} likes • ${fmt(totalComments)} komen`);
  setText('stat-engagement', `${engRate}%`);
}

// ── Channel Cards (platform summary row) ─────────────────────────────────────
function renderChannelCards(accounts) {
  const container = document.getElementById('channel-quick-cards');
  if (!container) return;
  container.innerHTML = '';

  if (accounts.length === 0) {
    container.innerHTML = `<div class="col-span-3 text-center text-slate-500 text-xs py-4">Belum ada data platform. Tunggu sync selesai.</div>`;
    return;
  }

  accounts.forEach(acc => {
    const icon = PLATFORM_ICON[acc.platform] || 'fa-solid fa-globe';
    const followerLabel = acc.platform === 'youtube' ? 'Subscribers' : 'Followers';
    const followerVal = acc.platform === 'youtube'
      ? shortNum(acc.subscribers)
      : shortNum(acc.followers);
    const platformLabel = acc.platform.charAt(0).toUpperCase() + acc.platform.slice(1);

    container.innerHTML += `
      <div onclick="openPlatformModal('${acc.platform}')"
           class="card-luxury p-4 rounded-2xl flex items-center justify-between cursor-pointer hover:border-accentcyan/30 hover:bg-white/[0.03] transition-all group">
        <div class="flex items-center space-x-3">
          <div class="w-9 h-9 rounded-xl bg-white/5 text-white flex items-center justify-center text-sm border border-white/10 group-hover:border-accentcyan/40 transition">
            <i class="${icon}"></i>
          </div>
          <div class="truncate">
            <h5 class="text-xs font-bold text-white truncate capitalize">${platformLabel}</h5>
            <span class="text-[10px] text-slate-400">${acc.date || ''} <i class="fa-solid fa-arrow-up-right-from-square text-[8px] opacity-40 ml-1"></i></span>
          </div>
        </div>
        <div class="text-right shrink-0">
          <span class="text-xs font-black text-white">${followerVal}</span>
          <p class="text-[10px] text-slate-500">${followerLabel}</p>
        </div>
      </div>
    `;
  });
}

// ════════════════════════════════════════════════════════════════════════════
// PLATFORM DETAIL MODAL (YouTube Studio & General)
// ════════════════════════════════════════════════════════════════════════════

const PLATFORM_CONFIG = {
  instagram: {
    label: 'Instagram',
    icon: 'fa-brands fa-instagram',
    handle: '@jadilebihfit',
    statsKeys: [
      { key: 'total_views',    label: 'Total Views' },
      { key: 'total_saves',    label: 'Total Saves' },
      { key: 'total_shares',   label: 'Total Shares' },
      { key: 'total_likes',    label: 'Total Likes' },
      { key: 'total_comments', label: 'Komentar' },
      { key: 'content_count',  label: 'Konten' }
    ]
  },
  threads: {
    label: 'Threads',
    icon: 'fa-solid fa-at',
    handle: '@jadilebihfit',
    statsKeys: [
      { key: 'total_views',    label: 'Total Views' },
      { key: 'total_likes',    label: 'Likes' },
      { key: 'total_comments', label: 'Replies' },
      { key: 'total_shares',   label: 'Reposts' },
      { key: 'content_count',  label: 'Posts' }
    ]
  },
  youtube: {
    label: 'YouTube Studio Analytics',
    icon: 'fa-brands fa-youtube',
    handle: 'Channel: Jadi Lebih Fit',
    statsKeys: [
      { key: 'total_views',    label: 'Total Views' },
      { key: 'total_likes',    label: 'Likes' },
      { key: 'total_comments', label: 'Komentar' },
      { key: 'content_count',  label: 'Video' }
    ]
  }
};

async function openPlatformModal(platform, modalTimeframe = null) {
  activeModalPlatform = platform;
  const tf = modalTimeframe || document.getElementById('pdm-timeframe')?.value || '28d';
  const range = calculateDateRange(tf);

  const modal = document.getElementById('platform-detail-modal');
  const cfg = PLATFORM_CONFIG[platform] || { label: platform, icon: 'fa-solid fa-globe', handle: '', statsKeys: [] };

  document.getElementById('pdm-icon').innerHTML = `<i class="${cfg.icon}"></i>`;
  document.getElementById('pdm-title').textContent = cfg.label;
  document.getElementById('pdm-subtitle').textContent = cfg.handle;
  document.getElementById('pdm-stats').innerHTML = '';
  document.getElementById('pdm-content-list').innerHTML = '';
  document.getElementById('pdm-loading').classList.remove('hidden');

  const pdmTfSelect = document.getElementById('pdm-timeframe');
  if (pdmTfSelect) pdmTfSelect.value = tf;

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  try {
    const [overviewRes, contentsRes] = await Promise.all([
      fetch(`/api/overview?from=${range.from}&to=${range.to}`),
      fetch(`/api/contents?platform=${platform}&sort=views&order=DESC&pageSize=50&from=${range.from}&to=${range.to}`)
    ]);

    const overview     = await overviewRes.json();
    const contentsData = await contentsRes.json();

    const platformStats = (overview.platforms || []).find(p => p.platform === platform) || {};
    const accountInfo   = (overview.accounts  || []).find(a => a.platform === platform) || {};
    const contents      = contentsData.contents || [];

    document.getElementById('pdm-loading').classList.add('hidden');

    if (platform === 'youtube') {
      renderYouTubeModal(platformStats, accountInfo, contents, tf);
    } else {
      renderGenericModal(platform, cfg, platformStats, accountInfo, contents);
    }

  } catch (e) {
    document.getElementById('pdm-loading').innerHTML =
      `<span class="text-red-400 text-xs">Gagal memuat: ${escHtml(e.message)}</span>`;
  }
}

async function onModalTimeframeChange(newTf) {
  if (activeModalPlatform) {
    await openPlatformModal(activeModalPlatform, newTf);
  }
}

// ── YouTube Studio-Style Modal Renderer ───────────────────────────────────────
function renderYouTubeModal(stats, account, contents, tf) {
  const statsEl = document.getElementById('pdm-stats');

  const totalWatchTime = contents.reduce((sum, c) =>
    c.estimated_minutes_watched ? sum + Number(c.estimated_minutes_watched) : sum, 0);
  const totalSubsGained = contents.reduce((sum, c) =>
    c.subscribers_gained ? sum + Number(c.subscribers_gained) : sum, 0);

  const kpis = [
    { label: 'Subscribers', val: shortNum(account.subscribers), accent: true },
    { label: 'Total Views',  val: shortNum(stats.total_views) },
    { label: 'Watch Time',   val: fmtWatchTime(totalWatchTime) },
    { label: 'Likes',        val: shortNum(stats.total_likes) },
    { label: 'Komentar',     val: shortNum(stats.total_comments) },
    { label: 'Subs Gained',  val: totalSubsGained > 0 ? `+${shortNum(totalSubsGained)}` : '0' },
  ];

  statsEl.innerHTML = kpis.map(k => `
    <div class="bg-white/[0.03] border border-white/5 rounded-xl p-3 text-center">
      <div class="text-sm font-extrabold ${k.accent ? 'text-accentcyan' : 'text-white'}">${k.val}</div>
      <div class="text-[10px] text-slate-500 mt-0.5">${k.label}</div>
    </div>
  `).join('');

  const contentList = document.getElementById('pdm-content-list');

  if (contents.length === 0) {
    contentList.innerHTML = `<p class="text-xs text-slate-500 text-center py-6">Belum ada video tersinkronisasi pada periode ini.</p>`;
    return;
  }

  contentList.innerHTML = `
    <div class="grid grid-cols-[1fr_auto] gap-2 px-3 pb-1 border-b border-white/5 mb-1">
      <span class="text-[10px] uppercase tracking-wider text-slate-600 font-bold">Video & Shorts</span>
      <div class="grid grid-cols-4 gap-3 sm:gap-4 text-right">
        <span class="text-[10px] uppercase tracking-wider text-slate-600 font-bold">Views</span>
        <span class="text-[10px] uppercase tracking-wider text-slate-600 font-bold">Watch Time</span>
        <span class="text-[10px] uppercase tracking-wider text-accentcyan/70 font-bold">Retensi</span>
        <span class="text-[10px] uppercase tracking-wider text-slate-600 font-bold">Likes</span>
      </div>
    </div>
  `;

  contents.forEach((c, i) => {
    const thumb    = c.thumbnail_url || '';
    const title    = escHtml(c.display_title || 'Tanpa Judul');
    const link     = c.url || '#';
    const age      = relativeDate(c.published_at);
    const dur      = fmtDuration(c.duration_seconds);
    const isShort  = c.content_type === 'SHORT';
    const typeTag  = isShort
      ? `<span class="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-white/10 text-white">Short</span>`
      : `<span class="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-white/5 text-slate-500">Video</span>`;

    const avgPct   = c.average_view_percentage;
    const avgPctBar = avgPct !== null && avgPct !== undefined
      ? `<div class="w-full bg-white/5 rounded-full h-1 mt-1 overflow-hidden">
           <div class="h-1 rounded-full bg-accentcyan" style="width:${Math.min(100, avgPct)}%"></div>
         </div>`
      : '';

    contentList.innerHTML += `
      <div class="grid grid-cols-[1fr_auto] gap-2 items-center p-2.5 rounded-xl hover:bg-white/[0.03] transition border border-transparent hover:border-white/5 group">

        <!-- Left: thumbnail + info -->
        <div class="flex items-start gap-2.5 min-w-0">
          <span class="text-[10px] text-slate-600 font-bold shrink-0 w-4 pt-1">${i + 1}</span>
          <div class="relative shrink-0">
            ${thumb
              ? `<img src="${thumb}" class="w-14 h-9 rounded-lg object-cover border border-white/5" onerror="this.style.display='none'" alt="">`
              : `<div class="w-14 h-9 rounded-lg bg-white/5 border border-white/5 flex items-center justify-center"><i class="fa-brands fa-youtube text-slate-600 text-xs"></i></div>`}
            ${dur ? `<span class="absolute bottom-0.5 right-0.5 text-[8px] bg-black/80 text-white px-1 rounded">${dur}</span>` : ''}
          </div>
          <div class="min-w-0 flex-1">
            <a href="${link}" target="_blank"
               class="text-xs font-bold text-white hover:text-accentcyan line-clamp-2 leading-snug block">${title}</a>
            <div class="flex items-center gap-1.5 mt-0.5 flex-wrap">
              <span class="text-[10px] text-slate-500">${age}</span>
              ${typeTag}
            </div>
          </div>
        </div>

        <!-- Right: metrics grid -->
        <div class="grid grid-cols-4 gap-3 sm:gap-4 text-right items-center shrink-0">
          <div>
            <div class="text-xs font-extrabold text-white">${shortNum(c.views)}</div>
            <div class="text-[9px] text-slate-600">tayangan</div>
          </div>

          <div>
            <div class="text-xs font-bold text-slate-300">${fmtWatchTime(c.estimated_minutes_watched)}</div>
            <div class="text-[9px] text-slate-600">tonton</div>
          </div>

          <div class="min-w-[48px]">
            <div class="text-xs font-bold text-accentcyan">
              ${avgPct !== null && avgPct !== undefined ? avgPct.toFixed(1) + '%' : '0.0%'}
            </div>
            <div class="text-[9px] text-slate-600">retensi</div>
            ${avgPctBar}
          </div>

          <div>
            <div class="text-xs font-bold text-slate-300">${shortNum(c.likes)}</div>
            <div class="text-[9px] text-slate-600">likes</div>
          </div>
        </div>
      </div>
    `;
  });
}

// ── Generic Modal Renderer (Instagram / Threads) ──────────────────────────────
function renderGenericModal(platform, cfg, stats, account, contents) {
  const statsEl = document.getElementById('pdm-stats');

  if (platform === 'youtube' && account.subscribers != null) {
    statsEl.innerHTML += statBox('Subscribers', account.subscribers, true);
  }
  if ((platform === 'instagram' || platform === 'threads') && account.followers != null) {
    statsEl.innerHTML += statBox('Followers', account.followers, true);
  }

  cfg.statsKeys.forEach(({ key, label }) => {
    statsEl.innerHTML += statBox(label, stats[key]);
  });

  const contentList = document.getElementById('pdm-content-list');

  if (contents.length === 0) {
    contentList.innerHTML = `<p class="text-xs text-slate-500 text-center py-6">Belum ada konten tersinkronisasi pada periode ini.</p>`;
    return;
  }

  contents.forEach((c, i) => {
    const thumb   = c.thumbnail_url || '';
    const title   = escHtml(c.display_title || 'Tanpa Judul');
    const link    = c.url || '#';
    const age     = relativeDate(c.published_at);
    const typeTag = c.content_type
      ? `<span class="text-[9px] uppercase text-slate-500 bg-white/5 px-1.5 py-0.5 rounded">${c.content_type}</span>`
      : '';

    contentList.innerHTML += `
      <div class="flex items-start gap-3 p-3 rounded-xl hover:bg-white/[0.03] transition border border-transparent hover:border-white/5">
        <span class="text-[10px] text-slate-600 font-bold w-4 shrink-0 pt-0.5">${i + 1}</span>
        ${thumb ? `<img src="${thumb}" class="w-10 h-10 rounded-lg object-cover shrink-0 border border-white/5" onerror="this.style.display='none'" alt="">` : ''}
        <div class="flex-1 min-w-0">
          <a href="${link}" target="_blank" class="text-xs font-bold text-white hover:text-accentcyan line-clamp-2 leading-snug block">${title}</a>
          <div class="flex items-center flex-wrap gap-1.5 mt-1">
            <span class="text-[10px] text-slate-500">${age}</span>
            ${typeTag}
          </div>
        </div>
        <div class="text-right shrink-0 space-y-0.5">
          <div class="text-xs font-extrabold text-white">${shortNum(c.views)}<span class="text-[9px] text-slate-500 font-normal ml-1">views</span></div>
          <div class="text-[10px] font-bold text-accentcyan">${shortNum(c.saves)}<span class="text-[9px] font-normal ml-1">saves</span></div>
          <div class="text-[10px] text-slate-500">${shortNum(c.likes)} likes · ${shortNum(c.shares)} shares</div>
        </div>
      </div>
    `;
  });
}

function statBox(label, val, highlight = false) {
  const color = highlight ? 'text-accentcyan' : 'text-white';
  return `
    <div class="bg-white/[0.03] border border-white/5 rounded-xl p-3 text-center">
      <div class="text-sm font-extrabold ${color}">${shortNum(val)}</div>
      <div class="text-[10px] text-slate-500 mt-0.5">${label}</div>
    </div>
  `;
}

function closePlatformModal() {
  document.getElementById('platform-detail-modal').classList.add('hidden');
  document.body.style.overflow = '';
  activeModalPlatform = null;
}

document.addEventListener('click', (e) => {
  const modal = document.getElementById('platform-detail-modal');
  if (e.target === modal) closePlatformModal();
});

// ── Trend Chart ───────────────────────────────────────────────────────────────
function renderTrendChart(trend) {
  const labels = trend.map(d => d.date.substring(5));
  const views  = trend.map(d => d.views || 0);
  const saves  = trend.map(d => d.saves || 0);
  const likes  = trend.map(d => d.likes || 0);
  const shares = trend.map(d => d.shares || 0);

  const ctxTrend = document.getElementById('trendChart');
  if (!ctxTrend) return;
  if (trendChartInstance) trendChartInstance.destroy();

  trendChartInstance = new Chart(ctxTrend.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Views', data: views, borderColor: '#38BDF8', backgroundColor: 'rgba(56,189,248,0.08)', fill: true, tension: 0.35, borderWidth: 2 },
        { label: 'Saves', data: saves, borderColor: '#FFFFFF', backgroundColor: 'transparent', borderDash: [4, 4], tension: 0.35, borderWidth: 1.8 },
        { label: 'Likes', data: likes, borderColor: '#64748B', backgroundColor: 'transparent', tension: 0.35, borderWidth: 1.5 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#94A3B8', font: { size: 11, weight: 'bold' } } } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748B', font: { size: 10 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748B', font: { size: 10 } } }
      }
    }
  });

  // Doughnut
  const totalSavesSum  = saves.reduce((a, b) => a + b, 0);
  const totalLikesSum  = likes.reduce((a, b) => a + b, 0);
  const totalSharesSum = shares.reduce((a, b) => a + b, 0);

  const ctxComp = document.getElementById('compositionChart');
  if (!ctxComp) return;
  if (compositionChartInstance) compositionChartInstance.destroy();

  compositionChartInstance = new Chart(ctxComp.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: ['Saves', 'Likes', 'Shares'],
      datasets: [{ data: [totalSavesSum, totalLikesSum, totalSharesSum], backgroundColor: ['#38BDF8', '#FFFFFF', '#475569'], borderWidth: 0 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: '#94A3B8', font: { size: 11 } } } }
    }
  });
}

// ── Top Content Table (Overview tab) ─────────────────────────────────────────
function renderTopContent(contents) {
  const tbody = document.getElementById('top-videos-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (contents.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-8 text-center text-slate-500 text-xs">Belum ada data konten pada periode ini.</td></tr>`;
    return;
  }

  contents.forEach(v => {
    const thumb = v.thumbnail_url || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=100';
    const title = escHtml(v.display_title || 'Tanpa Judul');
    const link = v.url || '#';
    const age = relativeDate(v.published_at);
    const eng = calcEngRate(v.views, v.likes, v.comments, v.saves, v.shares);

    tbody.innerHTML += `
      <tr class="hover:bg-white/[0.02] transition">
        <td class="py-3 px-4 max-w-sm">
          <div class="flex items-center space-x-3">
            <img src="${thumb}" class="w-9 h-9 rounded-lg object-cover bg-cardsubtle shrink-0 border border-white/5" onerror="this.src='https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=100'" alt="thumb">
            <div class="truncate">
              <a href="${link}" target="_blank" class="font-bold text-white hover:text-accentcyan truncate block text-xs">${title}</a>
              <span class="text-[10px] text-slate-500">${age}</span>
            </div>
          </div>
        </td>
        <td class="py-3 px-3">${PLATFORM_BADGE[v.platform] || v.platform}</td>
        <td class="py-3 px-3 font-extrabold text-white">${shortNum(v.views)}</td>
        <td class="py-3 px-3 font-black text-accentcyan">${shortNum(v.saves)}</td>
        <td class="py-3 px-3 font-semibold text-slate-300">${shortNum(v.shares)}</td>
        <td class="py-3 px-3 text-slate-400">${shortNum(v.likes)} / ${shortNum(v.comments)}</td>
        <td class="py-3 px-3 font-bold text-accentcyan">${eng}</td>
      </tr>
    `;
  });
}

// ── Data warnings ────────────────────────────────────────────────────────────
function renderDataWarnings(warnings) {
  if (!warnings) return;
  const container = document.getElementById('data-warnings');
  if (!container) return;

  const msgs = [];
  if (warnings.instagramHistoricalNote) msgs.push(`<i class="fa-solid fa-circle-info mr-1 text-accentcyan"></i>${warnings.instagramHistoricalNote}`);
  if (warnings.youtubeTimezoneNote) msgs.push(`<i class="fa-solid fa-clock mr-1 text-accentcyan"></i>${warnings.youtubeTimezoneNote}`);

  if (msgs.length > 0) {
    container.innerHTML = msgs.map(m => `<p class="text-[10px] text-slate-500 leading-relaxed">${m}</p>`).join('');
    container.classList.remove('hidden');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Contents Tab — Full Table with Timeframe & Clean Numbers
// ════════════════════════════════════════════════════════════════════════════
let contentsPage = 1;
const CONTENTS_PAGE_SIZE = 20;

async function loadContentsTable() {
  const platform = document.getElementById('filter-platform')?.value || 'all';
  const tf       = document.getElementById('filter-timeframe')?.value || '28d';
  const sortBy   = document.getElementById('filter-sort')?.value || 'published_at';
  const q        = document.getElementById('filter-search')?.value || '';

  const range = calculateDateRange(tf);

  try {
    const params = new URLSearchParams({
      platform, sort: sortBy, q,
      page: contentsPage, pageSize: CONTENTS_PAGE_SIZE,
      from: range.from, to: range.to,
      order: 'DESC'
    });
    const res = await fetch(`/api/contents?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    renderContentsTable(json.contents || []);
    renderPagination(json.pagination);
  } catch (err) {
    console.error('[Dashboard] loadContentsTable error:', err);
    const tbody = document.getElementById('video-table-body');
    if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="py-8 text-center text-red-400 text-xs">Error: ${escHtml(err.message)}</td></tr>`;
  }
}

function renderContentsTable(contents) {
  const tbody = document.getElementById('video-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (contents.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="py-8 text-center text-slate-500 text-xs">Belum ada konten untuk filter dan periode ini.</td></tr>`;
    return;
  }

  contents.forEach(v => {
    const thumb = v.thumbnail_url || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=100';
    const title = escHtml(v.display_title || 'Tanpa Judul');
    const link = v.url || '#';
    const age = relativeDate(v.published_at);
    const type = v.content_type ? `<span class="text-[9px] text-slate-500 uppercase">${v.content_type}</span>` : '';
    const eng = calcEngRate(v.views, v.likes, v.comments, v.saves, v.shares);

    tbody.innerHTML += `
      <tr class="hover:bg-white/[0.02] transition">
        <td class="py-3.5 px-4 max-w-sm">
          <div class="flex items-center space-x-3">
            <img src="${thumb}" class="w-9 h-9 rounded-lg object-cover bg-cardsubtle shrink-0 border border-white/5" onerror="this.src='https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=100'" alt="thumb">
            <div class="truncate">
              <a href="${link}" target="_blank" class="font-bold text-white hover:text-accentcyan truncate block text-xs">${title}</a>
              <span class="text-[10px] text-slate-500">${age} ${type}</span>
            </div>
          </div>
        </td>
        <td class="py-3.5 px-3">${PLATFORM_BADGE[v.platform] || v.platform}</td>
        <td class="py-3.5 px-3 font-extrabold text-white">${shortNum(v.views)}</td>
        <td class="py-3.5 px-3 font-black text-accentcyan">${shortNum(v.saves)}</td>
        <td class="py-3.5 px-3 font-bold text-slate-300">${shortNum(v.shares)}</td>
        <td class="py-3.5 px-3 text-slate-300">${shortNum(v.likes)}</td>
        <td class="py-3.5 px-3 text-slate-400">${shortNum(v.comments)}</td>
        <td class="py-3.5 px-3 font-extrabold text-accentcyan">${eng}</td>
        <td class="py-3.5 px-4 text-center">
          <a href="${link}" target="_blank" class="px-2.5 py-1 text-[10px] font-semibold rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 border border-white/10 transition inline-flex items-center gap-1.5">
            <span>Buka</span><i class="fa-solid fa-arrow-up-right-from-square text-[9px]"></i>
          </a>
        </td>
      </tr>
    `;
  });
}

function renderPagination(pagination) {
  const el = document.getElementById('pagination-info');
  if (!el || !pagination) return;
  el.textContent = `Halaman ${pagination.page} dari ${pagination.totalPages} (${pagination.total} konten)`;
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Sync Status
// ════════════════════════════════════════════════════════════════════════════
async function loadSyncStatus() {
  try {
    const res = await fetch('/api/sync/status');
    if (!res.ok) return;
    const json = await res.json();
    renderSyncStatus(json);
  } catch {}
}

function renderSyncStatus(status) {
  const el = document.getElementById('sync-status-badge');
  if (!el) return;

  const allFailed = status.lastSyncRuns?.every(r => r.status === 'failed');
  const anyRunning = status.lastSyncRuns?.some(r => r.status === 'running') || Object.values(status.locks || {}).some(v => v);
  const hasTokenIssue = status.tokens?.some(t => t.status !== 'active');

  if (anyRunning) {
    el.innerHTML = `<i class="fa-solid fa-rotate fa-spin mr-1.5"></i>Sync berjalan...`;
    el.className = 'text-xs text-accentcyan flex items-center';
  } else if (allFailed || hasTokenIssue) {
    el.innerHTML = `<i class="fa-solid fa-triangle-exclamation mr-1.5"></i>Perlu konfigurasi .env`;
    el.className = 'text-xs text-amber-400 flex items-center';
  } else {
    const lastSync = status.lastSyncRuns?.[0]?.completedAt;
    el.innerHTML = `<i class="fa-solid fa-circle-check mr-1.5"></i>${lastSync ? relativeDate(lastSync) : 'Siap'}`;
    el.className = 'text-xs text-slate-400 flex items-center';
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Manual Sync
// ════════════════════════════════════════════════════════════════════════════
async function triggerManualSync(platform = 'all') {
  const btn = document.getElementById('btn-submit-scrape');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-rotate fa-spin mr-1.5"></i>Menyinkronkan...`;
  }

  try {
    const res = await fetch(`/api/sync?platform=${platform}`, { method: 'POST' });
    const json = await res.json();

    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      if (attempts > 100) { clearInterval(poll); return; }

      const sr = await fetch('/api/sync/status').catch(() => null);
      if (!sr?.ok) return;
      const ss = await sr.json();
      const isRunning = Object.values(ss.locks || {}).some(v => v);

      if (!isRunning) {
        clearInterval(poll);
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = `<i class="fa-solid fa-rotate mr-1.5"></i>Sinkronkan Sekarang`;
        }
        await initDashboard();
      }
    }, 3000);

  } catch (err) {
    console.error('[Sync] error:', err);
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-rotate mr-1.5"></i>Sinkronkan Sekarang`;
    }
  }
}

function openQuickScrapeModal() {
  const modal = document.getElementById('quick-scrape-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeQuickScrapeModal() {
  const modal = document.getElementById('quick-scrape-modal');
  if (modal) modal.classList.add('hidden');
}

async function handleQuickScrape() {
  closeQuickScrapeModal();
  await triggerManualSync('all');
}

function applyFilters() {
  contentsPage = 1;
  loadContentsTable();
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showOverviewError(msg) {
  const el = document.getElementById('overview-error');
  if (el) {
    el.textContent = `Gagal memuat data: ${msg}`;
    el.classList.remove('hidden');
  }
}

async function refreshAllData() {
  await initDashboard();
  if (document.getElementById('tab-contents')?.classList.contains('hidden') === false) {
    await loadContentsTable();
  }
}
