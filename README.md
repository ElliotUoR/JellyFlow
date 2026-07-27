# JellyFlow

Landing page for jellyflow.xyz - lists the projects hosted on the domain.
Currently just links out to the RS3 Leagues Region Helper ("Leagues
Planner"), deployed separately at `/Leagues`.

Purely static (`public/index.html`, `public/style.css`) - no build step, no
backend of its own. `admin.html` is a password-protected analytics
dashboard (unique visitors, pageviews, session length, top pages/referrers)
that authenticates against and fetches data from the RS3 Leagues Region
Helper repo's Node service at `/Leagues/api/admin/*` - same origin
(`jellyflow.xyz`), so no CORS setup or backend of its own is needed here.
See that repo's `server/src/routes/admin.js` and
`server/src/lib/analyticsRollup.js` for how the data is collected and
rolled up.

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
