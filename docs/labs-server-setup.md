# labs VM — one-time setup

Everything the labs machine needs before `.github/workflows/deploy-labs.yml` can deploy to it.
Do this once; after that a push to `deploys/labs` in either repo ships on its own.

Both repos deploy to this same VM:

| Repo | Containers | Host port → container port |
|---|---|---|
| `request-mangement-backend` | `rm-user`, `rm-core` | 3501 → 3001, 3502 → 3002 |
| `request-management-frontend` | `rm-fe` | 3500 → 3000 |

Those container names and host ports are the same ones the `docker run` commands use, so the
stack looks identical whether compose or a person started it:

```bash
docker run -d --name rm-core --network rm-net -p 3502:3002 --env-file .backend-env  <image>
docker run -d --name rm-user --network rm-net -p 3501:3001 --env-file .backend-env  <image>
docker run -d --name rm-fe   --network rm-net -p 3500:3000 --env-file .frontend-env <image>
```

> **The cost of sharing the names.** compose refuses to adopt a container it did not create.
> Start one of these by hand and the next deploy stops with
> `Conflict. The container name "/rm-core" is already in use`. The fix is
> `docker rm -f rm-user rm-core rm-fe`, then re-run the workflow.

**The machine must be linux/amd64.** The images are built `--platform linux/amd64`; an ARM VM
cannot run them.

It also has to reach `192.168.31.55:5432` (Postgres) and `192.168.31.51:8180` (Keycloak) —
neither is installed here, both are existing services.

---

## 1. Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"     # the runner must call docker without sudo
newgrp docker                       # or log out and back in
docker compose version              # must report v2.x
```

---

## 2. Self-hosted runners — one per repo

A runner belongs to exactly one repository and nothing is registered at the organisation
level, so the VM runs two instances in separate directories. The machine is `worker-02`, and
both runners are named after it.

Each deploy job says `runs-on: [self-hosted]` — the bare automatic label, because these
runners carry no custom one. **A runner's name is not a label**, so `worker-02` is not
something `runs-on` can match; matching on `self-hosted` alone is what makes the jobs run as
registered.

The cost of that is precision: if either repo ever gains a second self-hosted runner, a deploy
will land on whichever is free. At that point give this VM a label (Settings → Actions →
Runners → the runner → edit labels — no reinstall needed) and put it back in `runs-on`.

> **With no self-hosted runner online for the repo, its `deploy` job sits in `Queued` forever
> and never reports an error.** GitHub cancels it after 24 hours. It looks like a hung
> pipeline, which is slow to diagnose — confirm 2.2 before pushing.

### 2.1 Register and install as a service

Get a **registration token** (valid one hour, single use) from each repo at
Settings → Actions → Runners → New self-hosted runner, then:

```bash
# Do NOT run as root — config.sh refuses. Use the user from step 1.
VER=$(curl -s https://api.github.com/repos/actions/runner/releases/latest \
      | grep -o '"tag_name": *"v[^"]*"' | cut -d'"' -f4 | tr -d v)

install_runner() {          # $1 = directory   $2 = repo url   $3 = token
  mkdir -p ~/"$1" && cd ~/"$1"
  curl -fsSL -o runner.tar.gz \
    "https://github.com/actions/runner/releases/download/v${VER}/actions-runner-linux-x64-${VER}.tar.gz"
  tar xzf runner.tar.gz && rm runner.tar.gz
  ./config.sh --unattended --replace --url "$2" --token "$3" --work _work
  sudo ./svc.sh install "$USER"
  sudo ./svc.sh start
}

install_runner actions-runner-rm-be \
  https://github.com/osd-internal-project/request-mangement-backend  <TOKEN_BE>

install_runner actions-runner-rm-fe \
  https://github.com/osd-internal-project/request-management-frontend <TOKEN_FE>
```

> **`./run.sh` is not enough.** It runs the listener in the foreground: close the session or
> press Ctrl+C and the runner goes offline immediately, and every queued deploy stops with it.
> `svc.sh install` + `svc.sh start` is what keeps it up across logout and reboot. An existing
> runner configured by hand only needs those two commands — no re-registration.

### 2.2 Confirm both runners are online

- **Web** — Settings → Actions → Runners on each repo: a green **Idle** dot. `Offline` means
  the service is not running.
- **On the VM** — `sudo ~/actions-runner-rm-be/svc.sh status` reports `active (running)`;
  same for the frontend directory.
- **API** — with a PAT that has `repo` scope:

  ```bash
  curl -s -H "Authorization: Bearer <PAT>" \
    https://api.github.com/repos/osd-internal-project/request-mangement-backend/actions/runners
  ```

  `"status": "online"` is the answer you want.

---

## 3. The shared network — nothing to do

The two stacks are separate compose projects, and they find each other by container name over
one shared network, `rm-net`. It is declared `external: true` in both compose files, meaning
no project owns it — which is exactly what lets the frontend resolve `rm-user` even though
that container belongs to the other project.

`external: true` also means compose will not create it, so **each deploy job creates it first**
(`Ensure Shared Network`, guarded by `docker network inspect`, so it is a no-op once it
exists). Nothing to run here by hand, including on a rebuilt VM.

For reference, the manual equivalent is:

```bash
docker network create rm-net
```

Without the network, `docker compose up` fails immediately with `network rm-net declared as
external, but could not be found`.

---

## 4. Environment files

Real configuration lives on the VM, never in git and never in a workflow log — so a secret is
not echoed on every deploy, and a wrong value is fixed by editing a file instead of re-running
a pipeline.

They live in the **runner user's** home, and compose reads them as that user — so no `sudo`
anywhere in this section. A root-owned `600` file here is unreadable by the runner, and the
deploy fails with `env file … not found` even though the file is plainly there.

```bash
mkdir -p ~/docker-env
chmod 700 ~/docker-env
```

Copy the two templates from the repos and fill them in:

| Template | Goes to |
|---|---|
| backend `.env.labs.example` | `~/docker-env/.backend-env` |
| frontend `.env.labs.example` | `~/docker-env/.frontend-env` |

```bash
install -m 600 /tmp/backend.env  ~/docker-env/.backend-env
install -m 600 /tmp/frontend.env ~/docker-env/.frontend-env
```

> The compose files name these paths absolutely (`/etc/request-management/…`), so they are
> tied to that account. Moving the runner to a different user means editing `env_file` in both
> `infra/labs/docker-compose.yml` — there is no indirection to adjust instead.

> **The trap worth naming.** `USER_SERVICE_URL` appears in both files and means opposite
> things. core-service wants `http://rm-user:3001/api/v1` — the prefix is part of the
> value. The frontend wants `http://rm-user:3001` — an origin, because
> `src/lib/backend.ts` appends `/api/v1` itself. Copying the line from one file to the other
> breaks whichever side receives it.

> **Which port goes where.** Service-to-service URLs use the port *inside* the container
> (3001, 3002) because those calls cross `rm-net` directly and never touch the host. Only
> `APP_ORIGIN` and the Keycloak redirect URIs use the published host port (3500), because a
> browser is what follows them.

Replace `<LABS_HOST>` in both files with this VM's address on the `192.168.31.x` network. It
has to be the address a **browser** uses, not a container name — it ends up in `APP_ORIGIN`
and in the Keycloak redirect, both of which the browser follows.

---

## 5. Keycloak

On `192.168.31.51:8180`, realm `enterprise-request`, client `request-form`:

- **Valid redirect URIs** — add `http://<LABS_HOST>:3500/*`
- **Valid post logout redirect URIs** — add `http://<LABS_HOST>:3500/*`
- **Web origins** — add `http://<LABS_HOST>:3500`

Absolute URLs only. A bare `/*` is resolved against the client's root URL and login fails with
*"Invalid parameter: redirect_uri"* — the warning `.env.example` already carries.

If labs points at a **different database** from dev, also run `yarn keycloak:provision`.
Without it `keycloak_role_mappings` is empty and every user resolves to no roles at all, which
looks like a broken permission system rather than missing setup.

---

## 6. Database migrations

Run once from a dev machine pointed at the labs database:

```bash
DATABASE_URL=<labs url> yarn prisma:migrate:deploy
```

**This is not automated.** The runtime images install with `--production`, and the Prisma CLI
is a devDependency, so neither image can migrate itself. Automating it means adding a
`migrator` stage to the Dockerfile — a separate piece of work. Until then, a deploy that
includes a new migration needs this command run by hand **first**, or the services will start
against a schema they do not match.

---

## 7. Firewall

Open **3500** to whoever uses the app. 3501 and 3502 only need to be reachable from the VM
itself — the frontend talks to them over the `rm-net` network, not through the host.

---

## Pre-flight — run these on the VM before pushing

Each failed deploy costs a full image build, so it is worth two minutes to check the things a
deploy cannot check for itself. All of these run **on the VM, as the runner's user**.

```bash
# 1. Can this machine reach the database? If not, core-service starts, answers
#    /health with 200, and reports "database":"down" — so `--wait` times out and
#    the deploy goes red with nothing obviously wrong in the logs.
nc -zv 192.168.31.55 5432

# 2. Can it reach Keycloak?
curl -sf http://192.168.31.51:8180/realms/enterprise-request >/dev/null && echo keycloak-ok

# 3. Are the env files readable BY THE RUNNER'S USER? Root-owned 600 files fail
#    here with "env file … not found", which reads like the file is missing.
head -1 ~/docker-env/.backend-env
head -1 ~/docker-env/.frontend-env

# 4. Is docker usable without sudo? The runner has no terminal to sudo from.
docker ps >/dev/null && echo docker-ok
```

Two more prerequisites will **not** turn the deploy red — they fail later, in use:

- **Keycloak redirect URIs** (step 5). Deploy goes green, then login dies with
  *"Invalid parameter: redirect_uri"*.
- **Database migrations** (step 6). The services start against a schema they do not match;
  queries fail one endpoint at a time rather than at boot.

---

## Deploying, after all of the above

Push to `deploys/labs` in either repo. The workflow builds on GitHub's runners, pushes to SWR,
then the `deploy` job on this VM creates the shared network if needed, pulls, and restarts that
stack with `--wait`, so the job only goes green once the healthchecks pass.

### Rolling back

There is no automatic rollback — compose has no equivalent of `helm --atomic`, and by the time
a deploy fails the previous containers are already replaced.

To go back: open the Actions run for the commit you want and **Re-run all jobs**. Image tags
are `<version>-<short sha>` and are never pushed over, so that run pulls exactly the bytes it
originally deployed.

For a faster manual path, if you know the tag:

```bash
cd /path/to/checkout
IMAGE_TAG=1.0.0-abc1234 docker compose -f infra/labs/docker-compose.yml up -d --pull always --wait
```

### When something is wrong

```bash
docker compose -f infra/labs/docker-compose.yml ps
docker compose -f infra/labs/docker-compose.yml logs --tail=100 core-service

# The check that distinguishes "running" from "actually working":
curl -s localhost:3502/api/v1/health     # must say "database":"up"
```

`/health` on core-service answers **200 even when the database is down** — the failure shows
only in the body. user-service's `/health` is static and says `ok` regardless. That is why the
compose healthchecks and the workflow's verify step both grep the body instead of trusting a
status code.
