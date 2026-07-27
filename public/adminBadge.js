// Shared "logged in as admin" badge for both JellyFlow pages (index.html,
// admin.html). The admin session cookie is httpOnly, so this is the only
// way either page can know "is the current visitor logged in as admin" -
// see the RS3 Leagues repo's server/src/routes/admin.js /whoami endpoint
// and server/src/lib/adminAuth.js for how it's actually checked.
async function checkAdminStatus() {
  try {
    const res = await fetch('/Leagues/api/admin/whoami', { credentials: 'include' });
    if (!res.ok) return false;
    const data = await res.json();
    return data.isAdmin === true;
  } catch {
    return false;
  }
}

if (await checkAdminStatus()) {
  const badge = document.createElement('div');
  badge.className = 'admin-badge';
  badge.textContent = 'Logged in as admin';
  document.body.appendChild(badge);
}
