// JellyFlow admin dashboard - plain JS, no build step (matches the rest of
// this repo). Talks to the RS3 Leagues repo's Node service, which already
// serves /Leagues/api/* on this same domain (see that repo's
// deploy/Caddyfile.snippet) - same-origin, so a relative path + the session
// cookie (Path=/) is all that's needed, no CORS setup here.
const API_BASE = '/Leagues/api/admin';
const SHORTLINKS_PAGE_SIZE = 25;

const loginForm = document.getElementById('login-form');
const loginPassword = document.getElementById('login-password');
const loginError = document.getElementById('login-error');
const dashboard = document.getElementById('dashboard');
const dashboardError = document.getElementById('dashboard-error');
const daysSelect = document.getElementById('days-select');
const logoutButton = document.getElementById('logout-button');
const shortlinksPrevButton = document.getElementById('shortlinks-prev');
const shortlinksNextButton = document.getElementById('shortlinks-next');

let pageviewsChart;
let shortlinksPage = 1;

function showLogin() {
  loginForm.hidden = false;
  dashboard.hidden = true;
}

function showDashboard() {
  loginForm.hidden = true;
  dashboard.hidden = false;
}

function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString();
}

function insertHeaderRow(table, labels) {
  const row = table.createTHead().insertRow();
  for (const label of labels) {
    const th = document.createElement('th');
    th.textContent = label;
    row.appendChild(th);
  }
}

function renderTable(table, rows, keyField, headerLabel) {
  table.innerHTML = '';
  insertHeaderRow(table, [headerLabel, 'Count']);

  if (rows.length === 0) {
    const row = table.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 2;
    cell.textContent = 'No data yet';
    return;
  }

  for (const row of rows) {
    const tr = table.insertRow();
    tr.insertCell().textContent = row[keyField];
    tr.insertCell().textContent = row.count;
  }
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
      scales: { y: { beginAtZero: true } },
    },
  });
}

function renderSummary(data) {
  document.getElementById('stat-visitors').textContent = data.uniqueVisitors.toLocaleString();
  document.getElementById('stat-pageviews').textContent = data.totalPageviews.toLocaleString();
  document.getElementById('stat-session-length').textContent = formatDuration(data.avgSessionSeconds);
  renderChart(data.dailySeries);
  renderTable(document.getElementById('top-paths-table'), data.topPaths, 'path', 'Page');
  renderTable(document.getElementById('top-referrers-table'), data.topReferrers, 'referrer', 'Referrer');
  renderTable(document.getElementById('top-browsers-table'), data.topBrowsers, 'browser', 'Browser');
  renderTable(document.getElementById('top-os-table'), data.topOperatingSystems, 'os', 'OS');
  renderTable(document.getElementById('top-device-types-table'), data.topDeviceTypes, 'deviceType', 'Device');
}

function renderShortlinksTable(data) {
  const table = document.getElementById('shortlinks-table');
  table.innerHTML = '';
  insertHeaderRow(table, ['Code', 'Created', 'Clicks', 'Last clicked']);

  if (data.items.length === 0) {
    const row = table.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 4;
    cell.textContent = 'No short links yet';
  } else {
    for (const item of data.items) {
      const tr = table.insertRow();
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
    renderSummary(await res.json());
    showDashboard();
    return true;
  } catch (err) {
    dashboardError.textContent = 'Could not load analytics right now.';
    dashboardError.hidden = false;
    console.error(err);
    return false;
  }
}

// Loads both the summary and the first shortlinks page - used on initial
// load and right after logging in. daysSelect's own change handler only
// reloads the summary (see below), so browsing a shortlinks page isn't lost
// just from tweaking the date range.
async function initDashboard() {
  const loaded = await loadSummary();
  if (loaded) await loadShortlinks(1);
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

daysSelect.addEventListener('change', loadSummary);
shortlinksPrevButton.addEventListener('click', () => loadShortlinks(shortlinksPage - 1));
shortlinksNextButton.addEventListener('click', () => loadShortlinks(shortlinksPage + 1));

// A valid session cookie from an earlier visit means the dashboard can load
// straight away - only fall back to the login form on a 401. Loaded as a
// module (see admin.html) specifically so this top-level await is valid.
await initDashboard();
