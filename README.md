# JellyFlow

Landing page for jellyflow.xyz - lists the projects hosted on the domain.
Currently just links out to the RS3 Leagues Region Helper ("Leagues
Planner"), deployed separately at `/Leagues`. May do more in the future.

Purely static (`public/index.html`, `public/style.css`) - no build step, no
backend of its own. `admin.html` is a password-protected analytics
dashboard (unique visitors, pageviews, session length, top pages/referrers)
that authenticates against and fetches data from the RS3 Leagues Region
Helper repo's Node service at `/Leagues/api/admin/*` - same origin
(`jellyflow.xyz`), so no CORS setup or backend of its own is needed here.
See that repo's `server/src/routes/admin.js` and
`server/src/lib/analyticsRollup.js` for how the data is collected and
rolled up.

### Dashboard controls

- **Refresh** reloads every panel on demand; **auto-refresh data** does the
  same on a 60s timer.
- **Auto-refresh active users** polls only `GET /Leagues/api/admin/active-users`
  on a 60s timer. That endpoint exists so the live gauge can be polled without
  re-running `/summary`'s Postgres aggregations every minute - **it ships in
  the RS3 Leagues repo, so deploy that before this toggle does anything**.
  Until then the dashboard detects the 404, disables the toggle and explains
  why, rather than failing on a loop.
- Containers driven by an active toggle carry a faint tint, so it is obvious
  which numbers are updating themselves.
- **Classic design** switches back to the original dashboard layout. Both
  designs render from the same fetched data and the same container ids - only
  the CSS and which row renderer runs in `admin.js` differ - so the toggle
  costs no extra requests. Preferences persist in `localStorage`.

Panels show their top 5 rows and expand over their neighbours on hover (or
click, for touch/keyboard) without reflowing the grid; lists longer than a
page get an in-panel pager. The traffic panels are capped server-side by
`TOP_N` in the RS3 repo's `routes/admin.js`.

## Structure

```
public/           the actual site (nginx serves this directory as-is)
  index.html
  style.css
  admin.html      analytics dashboard - login form + charts (Chart.js via CDN)
  admin.js        talks to /Leagues/api/admin/* (see RS3 Leagues repo)
deploy/
  docker-compose.yml    one nginx container serving public/
  Caddyfile.snippet      routing fragment for the shared Caddy setup
```

## Deploying

This site shares a Hetzner server and a single Caddy instance with every
other project on jellyflow.xyz (currently just the Leagues Planner). The
one-time shared network/Caddy setup (Docker `web` network, the canonical
`jellyflow.xyz { import ... }` block, the shared `conf.d` directory) is
documented in the RS3 Leagues Region Helper repo's `docs/deployment.md` -
do that first if it isn't done yet.

Once that's in place:

```bash
# get this repo onto the server, e.g.
git clone <this-repo-url> /opt/jellyflow-base
cd /opt/jellyflow-base/deploy
docker compose up -d

# add this project's routing fragment
cp Caddyfile.snippet /opt/caddy-shared/conf.d/jellyflow-base.caddy
cd /opt/livekit
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

Updating later is just `git pull` + re-copying `public/` (no build step) +
`docker compose up -d` if the container itself needs recreating (it
usually doesn't, since it mounts `public/` directly).

## Auto-deploy (CI/CD)

`.github/workflows/deploy.yml` SSHes into the server and re-runs the update
commands above on every push to `main`. It depends on the same dedicated
`deploy` user + SSH key set up once for the whole domain - see the RS3
Leagues Region Helper repo's `docs/deployment.md` section 11 for that
one-time setup. Once it's done, this repo just needs its own copy of the
same three GitHub Actions secrets (Settings → Secrets and variables →
Actions): `HETZNER_HOST`, `HETZNER_DEPLOY_USER`, `HETZNER_SSH_KEY`.

## Adding a new project to the list

Add a new `<li class="project-card">`-style entry to `public/index.html`
pointing at wherever that project is deployed (e.g. `/NewProject/`).
