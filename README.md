# JellyFlow

Landing page for jellyflow.xyz - lists the projects hosted on the domain.
Currently just links out to the RS3 Leagues Region Helper ("Leagues
Planner"), deployed separately at `/Leagues`.

Purely static for now (`public/index.html`, `public/style.css`) - no build
step, no backend. An `admin.html` placeholder exists for a future login +
analytics-viewing dashboard (reading the page_events data the Leagues
Planner already tracks), but that's not built yet - just reserving the
space.

## Structure

```
public/           the actual site (nginx serves this directory as-is)
  index.html
  style.css
  admin.html      placeholder - not wired up yet
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
