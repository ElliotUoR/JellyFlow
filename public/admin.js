// JellyFlow admin dashboard - plain JS, no build step (matches the rest of
// this repo). Talks to the RS3 Leagues repo's Node service, which already
// serves /Leagues/api/* on this same domain (see that repo's
// deploy/Caddyfile.snippet) - same-origin, so a relative path + the session
// cookie (Path=/) is all that's needed, no CORS setup here.
const API_BASE = '/Leagues/api/admin';
const SHORTLINKS_PAGE_SIZE = 25;

// Rows shown per page in a panel once it is expanded. The server returns up to
// 25 for the traffic panels (TOP_N in the RS3 repo's routes/admin.js) and
// every row for the usage ones, so the long lists page rather than scroll
// forever.
const PANEL_PAGE_SIZE = 12;
// How many rows a collapsed panel shows. Must match --panel-rows in style.css,
// which derives the collapsed height from it - this copy only decides whether
// the "more below" fade is shown.
const COLLAPSED_ROWS = 5;
const AUTO_REFRESH_MS = 60 * 1000;
const CLOCK_TICK_MS = 10 * 1000;

const STORAGE_KEYS = {
  design: 'jf-admin-design',
  autoActive: 'jf-admin-auto-active',
  autoData: 'jf-admin-auto-data',
};

const loginForm = document.getElementById('login-form');
const loginPassword = document.getElementById('login-password');
const loginError = document.getElementById('login-error');
const dashboard = document.getElementById('dashboard');
const dashboardError = document.getElementById('dashboard-error');
const daysSelect = document.getElementById('days-select');
const logoutButton = document.getElementById('logout-button');
const refreshButton = document.getElementById('refresh-button');
const lastUpdatedEl = document.getElementById('last-updated');
const autoActiveToggle = document.getElementById('auto-active-toggle');
const autoDataToggle = document.getElementById('auto-data-toggle');
const classicToggle = document.getElementById('classic-toggle');
const shortlinksPrevButton = document.getElementById('shortlinks-prev');
const shortlinksNextButton = document.getElementById('shortlinks-next');

let pageviewsChart;
let shortlinksPage = 1;

// Everything the dashboard has fetched, kept so the design toggle and the
// panel pagers can re-render without going back to the network.
const state = {
  summary: null,
  usage: null,
  lastUpdatedAt: null,
  refreshing: false,
  // Set once the active-users endpoint 404s, so the poll doesn't keep firing
  // at a backend that hasn't shipped it yet (this dashboard and the RS3
  // service deploy independently).
  activeUsersUnavailable: false,
};

let autoActiveTimer = null;
let autoDataTimer = null;

// tableId -> which slice of which payload fills it. Drives both renderers and
// the per-panel pagers, so a panel is described in exactly one place.
const PANELS = [
  { tableId: 'top-paths-table', source: 'summary', field: 'topPaths', key: 'path', header: 'Page' },
  { tableId: 'top-referrers-table', source: 'summary', field: 'topReferrers', key: 'referrer', header: 'Referrer' },
  { tableId: 'top-browsers-table', source: 'summary', field: 'topBrowsers', key: 'browser', header: 'Browser' },
  { tableId: 'top-os-table', source: 'summary', field: 'topOperatingSystems', key: 'os', header: 'OS' },
  { tableId: 'top-device-types-table', source: 'summary', field: 'topDeviceTypes', key: 'deviceType', header: 'Device' },
  { tableId: 'top-region-picks-table', source: 'usage', field: 'regionPicks', key: 'region', header: 'Region' },
  { tableId: 'top-region-combos-table', source: 'usage', field: 'regionCombos', key: 'combo', header: 'Combination' },
  { tableId: 'top-league-relics-table', source: 'usage', field: 'leagueRelicPicks', key: 'relic', header: 'Relic' },
  { tableId: 'top-drop-table-views-table', source: 'usage', field: 'dropTableViews', key: 'relic', header: 'Relic' },
  { tableId: 'top-build-guide-views-table', source: 'usage', field: 'buildGuideViews', key: 'build', header: 'Build' },
  { tableId: 'top-blessing-picks-table', source: 'usage', field: 'blessingPicks', key: 'blessing', header: 'Blessing' },
];

// Current page per panel, by tableId. Deliberately survives a refresh - an
// auto-refresh tick shouldn't yank you back to page 1 of a list you're reading.
const panelPages = new Map();

function showLogin() {
  loginForm.hidden = false;
  dashboard.hidden = true;
  stopAutoActive();
  stopAutoData();
}

function showDashboard() {
  loginForm.hidden = true;
  dashboard.hidden = false;
}

function isClassic() {
  return dashboard.dataset.design === 'classic';
}

function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString();
}

// Stat tiles are display-size numbers, so they get compacted past 5 digits to
// stay on one line; the exact figure stays in the title attribute.
function formatCompact(n) {
  if (n < 10000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function setStat(id, value, exact) {
  const el = document.getElementById(id);
  el.textContent = value;
  if (exact !== undefined) el.title = exact;
}

function insertHeaderRow(table, labels) {
  const row = table.createTHead().insertRow();
  for (const label of labels) {
    const th = document.createElement('th');
    th.textContent = label;
    row.appendChild(th);
  }
}

// table.insertRow() appends to the table's LAST section, and createTHead() has
// always run first here - so every data row was landing inside <thead>, which
// is why the classic design renders each row in header weight and why
// `.stats-table tbody tr` never matched. Rows go in an explicit tbody instead.
function bodyOf(table) {
  return table.tBodies[0] ?? table.createTBody();
}

function emptyRow(table, colSpan, message) {
  const row = bodyOf(table).insertRow();
  const cell = row.insertCell();
  cell.colSpan = colSpan;
  cell.className = 'empty-cell';
  cell.textContent = message;
}

// The original design's renderer, so "Classic design" really is the old
// dashboard rather than a restyled approximation of it: every row, no rank
// column, no bars, no pager. Only difference from what shipped before is the
// tbody fix above, which is a correctness fix rather than a design change.
function renderTable(table, rows, keyField, headerLabel) {
  table.innerHTML = '';
  insertHeaderRow(table, [headerLabel, 'Count']);

  if (rows.length === 0) {
    emptyRow(table, 2, 'No data yet');
    return;
  }

  for (const row of rows) {
    const tr = bodyOf(table).insertRow();
    tr.insertCell().textContent = row[keyField];
    tr.insertCell().textContent = row.count;
  }
}

// The current design's renderer: one page of rows, each with its overall rank
// and a magnitude bar. Bars are scaled to the largest count in the whole list
// rather than the page, so the bar for #1 on page 2 doesn't jump back to full
// width and misstate its size.
function renderRankTable(table, rows, keyField, headerLabel, page, maxCount) {
  table.innerHTML = '';
  insertHeaderRow(table, ['#', headerLabel, 'Count']);

  if (rows.length === 0) {
    emptyRow(table, 3, 'No data yet');
    return;
  }

  const start = (page - 1) * PANEL_PAGE_SIZE;
  rows.slice(start, start + PANEL_PAGE_SIZE).forEach((row, i) => {
    const tr = bodyOf(table).insertRow();

    const rankCell = tr.insertCell();
    rankCell.className = 'rank-cell';
    rankCell.textContent = start + i + 1;

    // textContent throughout, never innerHTML - paths and especially referrers
    // are visitor-supplied strings that arrive here unescaped.
    const labelCell = tr.insertCell();
    labelCell.className = 'label-cell';
    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = row[keyField];
    label.title = row[keyField];
    labelCell.appendChild(label);

    const track = document.createElement('span');
    track.className = 'row-track';
    const fill = document.createElement('span');
    fill.className = 'row-fill';
    fill.style.width = `${maxCount > 0 ? (row.count / maxCount) * 100 : 0}%`;
    track.appendChild(fill);
    labelCell.appendChild(track);

    const countCell = tr.insertCell();
    countCell.className = 'count-cell';
    countCell.textContent = row.count.toLocaleString();
  });
}

function panelElFor(tableId) {
  return document.getElementById(tableId).closest('[data-panel]');
}

function renderPanel(panel) {
  const table = document.getElementById(panel.tableId);
  const panelEl = panelElFor(panel.tableId);
  const payload = state[panel.source];
  // Nothing fetched for this source yet - leave the panel alone rather than
  // painting "No data yet" over it. renderAllPanels runs when the summary
  // lands, which is before the usage payload it shares the call with, so
  // without this the usage panels would flash empty on every load.
  if (!payload) return;
  // `?? []` rather than assuming the field exists: this dashboard and the RS3
  // backend deploy independently, so a field this build knows about may not be
  // in the response yet. Renders "No data yet" instead of throwing and
  // blanking every panel after it.
  const rows = payload[panel.field] ?? [];

  const pager = panelEl.querySelector('[data-panel-pager]');
  const meta = panelEl.querySelector('[data-panel-meta]');

  if (isClassic()) {
    renderTable(table, rows, panel.key, panel.header);
    pager.hidden = true;
    meta.textContent = '';
    panelEl.classList.remove('has-more', 'is-pinned');
    return;
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / PANEL_PAGE_SIZE));
  // Clamped rather than reset: a refresh that shortens a list shouldn't strand
  // the panel on a page that no longer exists.
  const page = Math.min(panelPages.get(panel.tableId) ?? 1, totalPages);
  panelPages.set(panel.tableId, page);

  const maxCount = rows.length > 0 ? Math.max(...rows.map((r) => r.count)) : 0;
  renderRankTable(table, rows, panel.key, panel.header, page, maxCount);

  meta.textContent = rows.length > 0 ? `${rows.length}` : '';
  // Drives the "there is more below" fade at the panel's bottom edge. Only set
  // when rows really are clipped, so a 3-row panel doesn't advertise depth it
  // hasn't got.
  panelEl.classList.toggle('has-more', rows.length > COLLAPSED_ROWS);
  pager.hidden = totalPages <= 1;
  if (totalPages > 1) {
    panelEl.querySelector('[data-pager-info]').textContent = `${page} / ${totalPages}`;
    panelEl.querySelector('[data-pager-prev]').disabled = page <= 1;
    panelEl.querySelector('[data-pager-next]').disabled = page >= totalPages;
  }
}

function renderAllPanels() {
  for (const panel of PANELS) renderPanel(panel);
}

function chartColor(varName) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

function renderChart(dailySeries) {
  const ctx = document.getElementById('pageviews-chart');
  const labels = dailySeries.map((d) => d.day);
  const pageviews = dailySeries.map((d) => d.pageviews);
  const uniqueVisitors = dailySeries.map((d) => d.uniqueVisitors);

  if (pageviewsChart) pageviewsChart.destroy();
  pageviewsChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Pageviews', data: pageviews, borderColor: chartColor('--chart-1'), borderWidth: 2, tension: 0.2, pointRadius: 3 },
        { label: 'Unique visitors', data: uniqueVisitors, borderColor: chartColor('--chart-2'), borderWidth: 2, tension: 0.2, pointRadius: 3 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true },
        // Chart.js will happily print all 90 day labels at a 90-day range and
        // rotate them into an unreadable comb. Same chart, legible axis.
        x: { ticks: { autoSkip: true, maxTicksLimit: 12, maxRotation: 0 } },
      },
    },
  });
}

// A 12-point trend line for the tiles that have a daily series behind them.
// Built as an inline SVG rather than a second Chart.js instance - it carries
// shape only, so an axis-less path is the whole form.
function renderSparkline(el, values) {
  el.replaceChildren();
  if (values.length < 2) return;

  const points = values.slice(-12);
  const width = 100;
  const height = 24;
  const max = Math.max(...points, 1);
  const step = width / (points.length - 1);
  const coords = points.map((v, i) => [i * step, height - (v / max) * (height - 2) - 1]);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('focusable', 'false');

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', coords.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' '));
  line.setAttribute('class', 'spark-line');
  // preserveAspectRatio="none" stretches the 100x24 box to whatever width the
  // tile is, which would stretch the stroke with it - this keeps it 2px.
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(line);

  const [lastX, lastY] = coords[coords.length - 1];
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', lastX.toFixed(2));
  dot.setAttribute('cy', lastY.toFixed(2));
  dot.setAttribute('r', '2.5');
  dot.setAttribute('class', 'spark-dot');
  dot.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(dot);

  el.appendChild(svg);
}

function renderActiveUsers(count) {
  setStat('stat-active-users', formatCompact(count), count.toLocaleString());
}

function renderSummary(data) {
  // `?? 0` rather than assuming the field for the same deploy-skew reason as
  // renderPanel's `?? []`.
  renderActiveUsers(data.activeUsers ?? 0);
  setStat('stat-visitors', formatCompact(data.uniqueVisitors), data.uniqueVisitors.toLocaleString());
  setStat('stat-pageviews', formatCompact(data.totalPageviews), data.totalPageviews.toLocaleString());
  setStat('stat-session-length', formatDuration(data.avgSessionSeconds));

  renderChart(data.dailySeries);
  renderSparkline(document.getElementById('spark-pageviews'), data.dailySeries.map((d) => d.pageviews));
  renderSparkline(document.getElementById('spark-visitors'), data.dailySeries.map((d) => d.uniqueVisitors));
}

// Ever-incrementing usage counters (see RS3's deploy/migrations/008_usage_counters.sql
// and routes/trackCounter.js) - all-time totals with no date-range concept
// of their own, unlike everything renderSummary shows, so this is not reloaded
// on daysSelect's change handler (see the change listener below).
function renderUsage(data) {
  setStat('stat-karamja-toggled-off', formatCompact(data.karamjaToggledOffCount), data.karamjaToggledOffCount.toLocaleString());
  setStat('stat-import-relics-used', formatCompact(data.importRelicsUsedCount), data.importRelicsUsedCount.toLocaleString());
}

function renderShortlinksTable(data) {
  const table = document.getElementById('shortlinks-table');
  table.innerHTML = '';
  insertHeaderRow(table, ['Code', 'Created', 'Clicks', 'Last clicked']);

  if (data.items.length === 0) {
    emptyRow(table, 4, 'No short links yet');
  } else {
    for (const item of data.items) {
      const tr = bodyOf(table).insertRow();
      const codeCell = tr.insertCell();
      const link = document.createElement('a');
      link.href = `/Leagues/s/${item.code}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = item.code;
      codeCell.appendChild(link);
      tr.insertCell().textContent = formatDate(item.createdAt);
      tr.insertCell().textContent = item.clickCount;
      tr.insertCell().textContent = item.lastClickedAt ? formatDate(item.lastClickedAt) : 'Never';
    }
  }

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  document.getElementById('shortlinks-page-info').textContent = `Page ${data.page} of ${totalPages} (${data.total} total)`;
  shortlinksPrevButton.disabled = data.page <= 1;
  shortlinksNextButton.disabled = data.page >= totalPages;
}

async function loadUsage() {
  try {
    const res = await fetch(`${API_BASE}/usage`, { credentials: 'include' });
    if (res.status === 401) {
      showLogin();
      return;
    }
    if (!res.ok) throw new Error(`usage failed: ${res.status}`);
    state.usage = await res.json();
    renderUsage(state.usage);
    renderAllPanels();
  } catch (err) {
    console.error(err);
  }
}

async function loadShortlinks(page) {
  try {
    const res = await fetch(`${API_BASE}/shortlinks?page=${page}&pageSize=${SHORTLINKS_PAGE_SIZE}`, {
      credentials: 'include',
    });
    if (res.status === 401) {
      showLogin();
      return;
    }
    if (!res.ok) throw new Error(`shortlinks failed: ${res.status}`);
    const data = await res.json();
    shortlinksPage = data.page;
    renderShortlinksTable(data);
  } catch (err) {
    console.error(err);
  }
}

// Returns whether the summary actually loaded (vs. falling back to the
// login form) - callers use this to decide whether it's worth also loading
// the shortlinks page (see initDashboard).
async function loadSummary() {
  dashboardError.hidden = true;
  try {
    const res = await fetch(`${API_BASE}/summary?days=${daysSelect.value}`, { credentials: 'include' });
    if (res.status === 401) {
      showLogin();
      return false;
    }
    if (!res.ok) throw new Error(`summary failed: ${res.status}`);
    state.summary = await res.json();
    renderSummary(state.summary);
    renderAllPanels();
    showDashboard();
    return true;
  } catch (err) {
    dashboardError.textContent = 'Could not load analytics right now.';
    dashboardError.hidden = false;
    console.error(err);
    return false;
  }
}

// Just the live gauge, from its own endpoint (see the RS3 repo's
// routes/admin.js) - polling /summary for this would re-run ~8 Postgres
// aggregations a minute to read a number held in that process's memory.
async function loadActiveUsers() {
  if (state.activeUsersUnavailable) return;
  try {
    const res = await fetch(`${API_BASE}/active-users`, { credentials: 'include' });
    if (res.status === 401) {
      showLogin();
      return;
    }
    // The endpoint is newer than this page; if the RS3 service hasn't been
    // deployed with it yet, stop polling and say so rather than failing every
    // 60s in the console forever. "Auto-refresh data" still updates the tile.
    if (res.status === 404) {
      state.activeUsersUnavailable = true;
      stopAutoActive();
      autoActiveToggle.checked = false;
      autoActiveToggle.disabled = true;
      autoActiveToggle.closest('.switch').title =
        'The backend does not expose /api/admin/active-users yet - deploy the RS3 Leagues service to enable this.';
      persistToggles();
      return;
    }
    if (!res.ok) throw new Error(`active-users failed: ${res.status}`);
    const data = await res.json();
    renderActiveUsers(data.activeUsers ?? 0);
    if (state.summary) state.summary.activeUsers = data.activeUsers ?? 0;
  } catch (err) {
    console.error(err);
  }
}

function setLastUpdated(date) {
  state.lastUpdatedAt = date;
  paintLastUpdated();
}

function paintLastUpdated() {
  if (!state.lastUpdatedAt) {
    lastUpdatedEl.textContent = '';
    return;
  }
  const seconds = Math.round((Date.now() - state.lastUpdatedAt) / 1000);
  if (seconds < 10) lastUpdatedEl.textContent = 'Updated just now';
  else if (seconds < 60) lastUpdatedEl.textContent = `Updated ${seconds}s ago`;
  else lastUpdatedEl.textContent = `Updated ${Math.round(seconds / 60)}m ago`;
}

// Every data source at once - what the Refresh button and the "auto-refresh
// data" timer both run. Guarded so a click mid-refresh (or a timer tick that
// lands on a slow request) doesn't stack a second set of requests.
async function refreshAll() {
  if (state.refreshing) return;
  state.refreshing = true;
  refreshButton.classList.add('is-refreshing');
  refreshButton.disabled = true;
  try {
    const loaded = await loadSummary();
    if (loaded) {
      // The page you were on, not page 1 - same reasoning as panelPages.
      await Promise.all([loadShortlinks(shortlinksPage), loadUsage()]);
      setLastUpdated(Date.now());
    }
  } finally {
    state.refreshing = false;
    refreshButton.classList.remove('is-refreshing');
    refreshButton.disabled = false;
  }
}

function startAutoActive() {
  stopAutoActive();
  dashboard.dataset.liveActive = 'on';
  autoActiveTimer = setInterval(loadActiveUsers, AUTO_REFRESH_MS);
  loadActiveUsers();
}

function stopAutoActive() {
  if (autoActiveTimer) clearInterval(autoActiveTimer);
  autoActiveTimer = null;
  delete dashboard.dataset.liveActive;
}

function startAutoData() {
  stopAutoData();
  dashboard.dataset.liveData = 'on';
  autoDataTimer = setInterval(refreshAll, AUTO_REFRESH_MS);
}

function stopAutoData() {
  if (autoDataTimer) clearInterval(autoDataTimer);
  autoDataTimer = null;
  delete dashboard.dataset.liveData;
}

function persistToggles() {
  try {
    localStorage.setItem(STORAGE_KEYS.autoActive, String(autoActiveToggle.checked));
    localStorage.setItem(STORAGE_KEYS.autoData, String(autoDataToggle.checked));
    localStorage.setItem(STORAGE_KEYS.design, classicToggle.checked ? 'classic' : 'modern');
  } catch {
    // Private-browsing / blocked storage - the toggles still work for this
    // session, they just won't be remembered.
  }
}

function applyDesign() {
  dashboard.dataset.design = classicToggle.checked ? 'classic' : 'modern';
  renderAllPanels();
  // The chart's container changes size between the two layouts and Chart.js
  // only re-reads that on its own resize observer, which won't have fired yet.
  if (pageviewsChart) pageviewsChart.resize();
}

function restorePreferences() {
  let stored = {};
  try {
    stored = {
      design: localStorage.getItem(STORAGE_KEYS.design),
      autoActive: localStorage.getItem(STORAGE_KEYS.autoActive),
      autoData: localStorage.getItem(STORAGE_KEYS.autoData),
    };
  } catch {
    stored = {};
  }
  classicToggle.checked = stored.design === 'classic';
  autoActiveToggle.checked = stored.autoActive === 'true';
  autoDataToggle.checked = stored.autoData === 'true';
  dashboard.dataset.design = classicToggle.checked ? 'classic' : 'modern';
}

// Loads the summary, the first shortlinks page, and usage counters - used
// on initial load and right after logging in.
// ─────────────────────────────────────────────────────────────────────────
// Tier lists
//
// Two views of the same data: the aggregate ranking (how the community rates
// each blessing/relic on average), and every individual list rebuilt from its
// stored placements.
//
// Scores are 7 (top row) down to 1 (bottom). Row LABELS are renamable by their
// author, so nothing here reads them - a list that renames "S" to "Must pick"
// still averages against everyone else by row position. The labels are shown
// only when rebuilding that author's own list, where they are the point.
// ─────────────────────────────────────────────────────────────────────────
const TIER_ROW_HUES = [165, 140, 95, 45, 25, 5, 220];
const tierTypeButtons = document.querySelectorAll('[data-tier-type]');
const tierItemStatsTable = document.getElementById('tier-item-stats-table');
const tierListsContainer = document.getElementById('tier-lists-container');
const tierListsCount = document.getElementById('tier-lists-count');
let tierType = 'blessings';

// Built with DOM nodes and textContent, never innerHTML - author names, angle
// lines and row labels are all visitor-supplied and arrive here unescaped, the
// same rule renderRankedTable above follows for paths and referrers.
function cell(row, text, className) {
  const td = row.insertCell();
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function renderTierItemStats(stats) {
  tierItemStatsTable.innerHTML = '';
  if (stats.perItem.length === 0) {
    const body = tierItemStatsTable.createTBody();
    const td = body.insertRow().insertCell();
    td.className = 'empty-cell';
    td.textContent = 'No lists submitted yet.';
    return;
  }

  const head = tierItemStatsTable.createTHead().insertRow();
  for (const label of ['Entry', 'Avg', 'Ranked', 'Top tier', 'Unsorted', 'Spread', 'Our grade']) {
    const th = document.createElement('th');
    th.textContent = label;
    head.appendChild(th);
  }

  const body = tierItemStatsTable.createTBody();
  for (const item of stats.perItem) {
    const row = body.insertRow();
    cell(row, item.name);

    // A bar makes the ordering readable at a glance; the number stays for
    // anyone comparing two entries properly.
    const avg = row.insertCell();
    const bar = document.createElement('span');
    bar.className = 'tier-bar';
    const fill = document.createElement('span');
    fill.className = 'tier-bar-fill';
    fill.style.width = `${item.averageScore == null ? 0 : ((item.averageScore / 7) * 100).toFixed(0)}%`;
    bar.appendChild(fill);
    const value = document.createElement('span');
    value.className = 'tier-bar-value';
    value.textContent = item.averageScore == null ? '—' : item.averageScore.toFixed(2);
    avg.append(bar, value);

    cell(row, item.ranked);
    cell(row, `${item.topPct}%`);
    cell(row, `${item.unsortedPct}%`);
    cell(row, item.spread == null ? '—' : item.spread.toFixed(2));
    cell(row, item.curatedGrade ?? '—');
  }
}

function renderTierLists(lists) {
  tierListsCount.textContent = `${lists.length} list${lists.length === 1 ? '' : 's'}`;
  tierListsContainer.innerHTML = '';
  if (lists.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-cell';
    empty.textContent = 'No lists submitted yet.';
    tierListsContainer.appendChild(empty);
    return;
  }

  for (const list of lists) {
    const article = document.createElement('article');
    article.className = `tier-mini${list.hidden ? ' is-hidden' : ''}`;

    const header = document.createElement('header');
    header.className = 'tier-mini-head';
    const author = document.createElement('strong');
    // The name is optional on the maker, so an unnamed list is titled "My
    // <noun> tier list" there. Here it is one row among many, where "(unnamed)"
    // is more useful to scan than seven identical "My blessing tier list"s.
    author.textContent = list.authorName || '(unnamed)';
    if (!list.authorName) author.classList.add('tier-mini-unnamed');
    header.appendChild(author);
    if (list.angle) {
      const angle = document.createElement('span');
      angle.className = 'tier-mini-angle';
      angle.textContent = list.angle;
      header.appendChild(angle);
    }
    const when = document.createElement('span');
    when.className = 'tier-mini-meta';
    when.textContent = new Date(list.createdAt).toLocaleDateString();
    header.appendChild(when);

    const link = document.createElement('a');
    link.className = 'tier-mini-link';
    link.href = `/Leagues/tier-list/${tierType}/${encodeURIComponent(list.code)}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'open';
    header.appendChild(link);

    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'tier-mini-hide';
    hide.dataset.hideCode = list.code;
    hide.dataset.hidden = String(list.hidden);
    hide.textContent = list.hidden ? 'Un-hide' : 'Hide';
    header.appendChild(hide);

    // The author's own ranking, rebuilt - their row names included, since on
    // one specific list the labels are the point.
    const rows = document.createElement('div');
    rows.className = 'tier-mini-rows';
    list.rowLabels.forEach((label, index) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'tier-mini-row';
      const labelEl = document.createElement('span');
      labelEl.className = 'tier-mini-label';
      labelEl.style.setProperty('--tier-hue', TIER_ROW_HUES[index] ?? 220);
      labelEl.textContent = label;
      rowEl.appendChild(labelEl);

      const entries = document.createElement('span');
      entries.className = 'tier-mini-entries';
      const names = Object.entries(list.placements)
        .filter(([, row]) => row === index)
        .map(([name]) => name);
      if (names.length === 0) {
        const dash = document.createElement('span');
        dash.className = 'tier-mini-empty';
        dash.textContent = '—';
        entries.appendChild(dash);
      } else {
        for (const name of names) {
          const chip = document.createElement('span');
          chip.className = 'tier-mini-chip';
          chip.textContent = name;
          entries.appendChild(chip);
        }
      }
      rowEl.appendChild(entries);
      rows.append(rowEl);
    });

    article.append(header, rows);
    tierListsContainer.appendChild(article);
  }
}

async function loadTierLists() {
  try {
    const res = await fetch(`${API_BASE}/tier-lists?type=${tierType}`, { credentials: 'include' });
    if (res.status === 401) {
      showLogin();
      return;
    }
    if (!res.ok) throw new Error(`tier lists failed: ${res.status}`);
    const data = await res.json();
    document.getElementById('stat-tier-lists').textContent = data.stats.totalLists;
    document.getElementById('stat-tier-avg-placed').textContent = data.stats.averagePlaced;
    document.getElementById('stat-tier-divisive').textContent = data.stats.mostDivisive?.name ?? '—';
    document.getElementById('stat-tier-agreed').textContent = data.stats.mostAgreed?.name ?? '—';
    renderTierItemStats(data.stats);
    renderTierLists(data.lists);
  } catch (err) {
    console.error(err);
  }
}

for (const button of tierTypeButtons) {
  button.addEventListener('click', () => {
    tierType = button.dataset.tierType;
    for (const other of tierTypeButtons) {
      const active = other === button;
      other.classList.toggle('active', active);
      other.setAttribute('aria-selected', String(active));
    }
    loadTierLists();
  });
}

// Hiding is delegated because the list is re-rendered on every load.
tierListsContainer.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-hide-code]');
  if (!button) return;
  const hidden = button.dataset.hidden !== 'true';
  button.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/tier-lists/${encodeURIComponent(button.dataset.hideCode)}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden }),
    });
    if (!res.ok) throw new Error(`hide failed: ${res.status}`);
    await loadTierLists();
  } catch (err) {
    console.error(err);
    button.disabled = false;
  }
});

async function initDashboard() {
  const loaded = await loadSummary();
  if (loaded) {
    await Promise.all([loadShortlinks(1), loadUsage(), loadTierLists()]);
    setLastUpdated(Date.now());
    if (autoActiveToggle.checked) startAutoActive();
    if (autoDataToggle.checked) startAutoData();
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.hidden = true;
  try {
    const res = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: loginPassword.value }),
    });
    if (!res.ok) {
      loginError.textContent = res.status === 401 ? 'Wrong password.' : 'Login is unavailable right now.';
      loginError.hidden = false;
      return;
    }
    loginPassword.value = '';
    await initDashboard();
  } catch (err) {
    loginError.textContent = 'Login is unavailable right now.';
    loginError.hidden = false;
    console.error(err);
  }
});

logoutButton.addEventListener('click', async () => {
  await fetch(`${API_BASE}/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
  showLogin();
});

// Only the summary is date-scoped, so browsing a shortlinks page (or the usage
// counters, which have no date range at all) isn't lost just from tweaking the
// date range.
daysSelect.addEventListener('change', async () => {
  await loadSummary();
  setLastUpdated(Date.now());
});

refreshButton.addEventListener('click', refreshAll);

autoActiveToggle.addEventListener('change', () => {
  if (autoActiveToggle.checked) startAutoActive();
  else stopAutoActive();
  persistToggles();
});

autoDataToggle.addEventListener('change', () => {
  if (autoDataToggle.checked) startAutoData();
  else stopAutoData();
  persistToggles();
});

classicToggle.addEventListener('change', () => {
  applyDesign();
  persistToggles();
});

// Delegated so the eleven panels don't need eleven pairs of listeners, and so
// re-rendering a panel's contents can't detach them.
dashboard.addEventListener('click', (event) => {
  const button = event.target.closest('[data-pager-prev], [data-pager-next]');
  if (!button) return;
  const panelEl = button.closest('[data-panel]');
  const table = panelEl.querySelector('table');
  const panel = PANELS.find((p) => p.tableId === table.id);
  if (!panel) return;
  const delta = 'pagerNext' in button.dataset ? 1 : -1;
  panelPages.set(panel.tableId, Math.max(1, (panelPages.get(panel.tableId) ?? 1) + delta));
  renderPanel(panel);
});

// Touch and keyboard have no hover, so a panel can also be pinned open. Click
// anywhere on it that isn't a pager button or a link.
dashboard.addEventListener('click', (event) => {
  if (event.target.closest('[data-pager-prev], [data-pager-next], a')) return;
  const panelEl = event.target.closest('[data-panel]');
  if (!panelEl || isClassic()) return;
  panelEl.classList.toggle('is-pinned');
});

shortlinksPrevButton.addEventListener('click', () => loadShortlinks(shortlinksPage - 1));
shortlinksNextButton.addEventListener('click', () => loadShortlinks(shortlinksPage + 1));

setInterval(paintLastUpdated, CLOCK_TICK_MS);

restorePreferences();

// A valid session cookie from an earlier visit means the dashboard can load
// straight away - only fall back to the login form on a 401. Loaded as a
// module (see admin.html) specifically so this top-level await is valid.
await initDashboard();
