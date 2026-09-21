# Deploying to talents.fooxy.tv

Same shape as paddington: the app in one container, a `cloudflared` sidecar on a
compose profile publishing it. Runs on `swlxsvr01` (192.168.1.248) under `simon`.

```
~/git/workspace/cplus-talents/        the app
~/git/workspace/cplus-talents/deploy/ this folder - compose file and .env
```

## What changes on a public URL

The app has no accounts, so environment variables do the work instead:

| Variable | Effect |
| --- | --- |
| `ADMIN_KEY` | The talent trees, the version history and the edit bar are read-only to everyone who does not send this key. Without it set, **anyone visiting could rewrite the trees for everybody** — the root `docker-compose.yml` is for a LAN, not the internet. |
| `LOCAL_BUILDS=1` | Saved builds stay in each visitor's own browser. Nobody sees anyone else's list, and the server stores none of them. Builds are shared by URL, which already carries the whole build. |
| `TRUST_PROXY=1` | Believe Cloudflare's `CF-Connecting-IP`, so the suggestion limit counts real visitors instead of lumping everyone in behind the tunnel. |

### The suggestion limit

`SUGGEST_PER_IP_PER_HOUR` (5) is the one that matters: one visitor being a
nuisance cannot spend anybody else's allowance. `SUGGEST_PER_HOUR` (200) is a
backstop across everyone, high enough that normal use never meets it.

Counting is per address, so it only works if the server can see the address.
Behind the tunnel every request arrives from the `cloudflared` container, which
is why `TRUST_PROXY=1` is set — with it the header Cloudflare attaches is used
instead. Addresses are hashed with a per-process salt, held in memory only, and
never written to the database.

**`TRUST_PROXY` is a statement about what sits in front of the server.** Anything
that can reach the container directly — anyone on the LAN, via the published
`5502` — can send whatever `CF-Connecting-IP` it likes and hand itself a fresh
allowance every request. That is an acceptable trade on a home network. If it is
not, publish the port as `127.0.0.1:5502` instead and reach it over ssh.

Visitors can still: browse all six editions, build, save to their own browser,
copy a link, and leave a suggestion. That is all they can do.

## First run

1. **Make the tunnel.** Cloudflare Zero Trust → Networks → Tunnels → Create a
   tunnel named `talents`. Add a public hostname:

   | Field | Value |
   | --- | --- |
   | Subdomain | `talents` |
   | Domain | `fooxy.tv` |
   | Service | `HTTP` → `talents:8080` |

   `talents:8080` is the container's name on the compose network — not a LAN
   address, and not the published `5502`.

2. **Fill in `.env`:**

   ```bash
   cd ~/git/workspace/cplus-talents/deploy
   cp .env.example .env
   openssl rand -base64 30          # paste into ADMIN_KEY
   # paste the tunnel token into CLOUDFLARE_TUNNEL_TOKEN
   ```

3. **Check it on the LAN first**, before letting anyone in:

   ```bash
   docker compose up -d --build
   curl -s localhost:5502/api/config
   ```

   `"editMode":false` and `"localBuilds":true` mean the guards are on. If
   `editMode` is `true` for an anonymous request, `ADMIN_KEY` did not reach the
   container — stop and fix that before step 4.

4. **Publish it:**

   ```bash
   docker compose --profile tunnel up -d
   ```

## Your own way in

Open once with the key in the URL:

```
https://talents.fooxy.tv/?admin=<ADMIN_KEY>
```

The browser keeps it from then on, so the **Edit mode** button and the
suggestions list are simply there on later visits. To hand the key back:

```js
localStorage.removeItem("cplus-admin")   // in the browser console
```

Treat that URL like a password — anything you paste it into (a chat, a
screenshot) has handed over write access to the trees.

## Updating

```bash
cd ~/git/workspace/cplus-talents
# copy the new code up, then:
cd deploy && docker compose --profile tunnel up -d --build
```

The named volume `talent-data` survives rebuilds. `docker compose down` keeps it;
`docker compose down -v` deletes the suggestions and the edited trees.

## Backups

```bash
docker compose cp talents:/data/talents.db ./talents-backup.db
```

That one file holds the edited trees, every version in their history, and the
suggestions people have sent.

## Ports

`8080` is Traefik's on this host and `5500` is paddington's, so this uses `5502`.
The published port is for you on the LAN — Cloudflare reaches the container over
the compose network and does not need it.
