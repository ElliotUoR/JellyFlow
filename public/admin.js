// JellyFlow admin dashboard - plain JS, no build step (matches the rest of
// this repo). Talks to the RS3 Leagues repo's Node service, which already
// serves /Leagues/api/* on this same domain (see that repo's
// deploy/Caddyfile.snippet) - same-origin, so a relative path + the session
// cookie (Path=/) is all that's needed, no CORS setup here.
const API_BASE = '/Leagues/api/admin';

const loginForm = document.getElementById('login-form');
const loginPassword = document.getElementById('login-password');
const loginError = document.getElementById('login-error');
const dashboard = document.getElementById('dashboard');
const dashboardError = document.getElementById('dashboard-error');
const daysSelect = document.getElementById('days-select');
const logoutButton = document.getElementById('logout-button');

let pageviewsChart;

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

function renderTable(table, rows, keyField, headerLabel) {
  table.innerHTML = '';
  const thead = table.createTHead().insertRow();
  thead.insertCell().textContent = headerLabel;
  thead.insertCell().textContent = 'Count';

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
        { label: 'Pageviews', data: pageviews, borderColor: '#7a3bd6', tension: 0.2 },
        { label: 'Unique visitors', data: uniqueVisitors, borderColor: '#4b4b52', tension: 0.2 },
      ],
    },
    options: {
      responsive: true,
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
}

async function loadSummary() {
  dashboardError.hidden = true;
  try {
    const res = await fetch(`${API_BASE}/summary?days=${daysSelect.value}`, { credentials: 'include' });
    if (res.status === 401) {
      showLogin();
      return;
    }
    if (!res.ok) throw new Error(`summary failed: ${res.status}`);
    renderSummary(await res.json());
    showDashboard();
  } catch (err) {
    dashboardError.textContent = 'Could not load analytics right now.';
    dashboardError.hidden = false;
    console.error(err);
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
    await loadSummary();
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

// A valid session cookie from an earlier visit means the dashboard can load
// straight away - only fall back to the login form on a 401.
loadSummary();
