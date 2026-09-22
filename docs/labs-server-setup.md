# labs VM — one-time setup

Everything the labs machine needs before `.github/workflows/deploy-labs.yml` can deploy to it.
Do this once; after that a push to `deploys/labs` in either repo ships on its own.

For the per-deploy checklist — Keycloak redirect URIs, the pre-push checks, and what to do
when a deploy goes red — see [`labs-setup-th.md`](./labs-setup-th.md) (Thai).

Both repos deploy to this same VM:

| Repo | Containers | Host port → container port |
|---|---|---|
| `request-mangement-backend` | `rm-user`, `rm-core`, `rm-external`, `rm-runnumber` | 3501 → 3001, 3502 → 3002, 3503 → 3003, 3504 → 3004 |
| `request-management-frontend` | `rm-fe` | 3500 → 3000 |

Those container names and host ports are the same ones the `docker run` commands use, so the
stack looks identical whether compose or a person started it:

```bash
docker run -d --name rm-core     --network rm-net -p 3502:3002 --env-file .backend.env  <image>
docker run -d --name rm-user     --network rm-net -p 3501:3001 --env-file .backend.env  <image>
docker run -d --name rm-external --network rm-net -p 3503:3003 --env-file .backend.env  <image>
docker run -d --name rm-runnumber --network rm-net -p 3504:3004 --env-file .backend.env  <image>
docker run -d --name rm-fe       --network rm-net -p 3500:3000 --env-file .frontend.env <image>
```

> **The cost of sharing the names.** compose refuses to adopt a container it did not create.
> Start one of these by hand and the next deploy stops with
> `Conflict. The container name "/rm-core" is already in use`. The fix is
> `docker rm -f rm-user rm-core rm-external rm-runnumber rm-fe`, then re-run the workflow.

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
level, so the VM runs two instances in separate directories.

**On the machine in use today** both runners run as the user **`github-runner`**, from
directories under its home such as
`/home/github-runner/runner-request-management-console-sit/`. That user name is what §4's
`install -g github-runner` refers to — get it wrong and compose cannot read the env files.
Confirm it rather than assuming: the runner's own path appears at the top of any deploy log,
in the temp script it executes — and the `Check Labs Env File` step now prints `id -un` and
`id -Gn` on every deploy, so the identity that actually reads the env files is a fact in the
log rather than a claim in this paragraph. The directory names used by `install_runner` below are for
registering a *fresh* runner and need not match what is already there.

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
- **On the VM** — `sudo <runner dir>/svc.sh status` reports `active (running)`, for each of
  the two directories (`ls ~github-runner` to find their real names).
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

They live in `/etc/request-management/`, which is the path both `infra/labs/docker-compose.yml`
files name in `env_file`. **Compose reads them as the runner's user**, so what matters is not
where they are but whether that user can read them: a root-owned `600` file fails the deploy
with `env file … not found`, which reads like the file is missing when it is merely unreadable.

Both deploy workflows now check this themselves, in a `Check Labs Env File` step that runs
straight after checkout — before the registry login, and long before `docker compose up`. It
separates "absent" from "unreadable by this user" and prints the fix for each, so this
paragraph is no longer the only thing standing between a wrong group and a baffling deploy.
The same check is runnable by hand: `scripts/check-labs-env.sh`.

```bash
sudo install -d -m 755 /etc/request-management
```

Copy the two templates from the repos and fill them in:

| Template | Goes to |
|---|---|
| backend `.env.labs.example` | `/etc/request-management/.backend.env` |
| frontend `.env.labs.example` | `/etc/request-management/.frontend.env` |

`640` with the group set to the runner's own: readable by the deploy, not by anyone else with
an account on this VM.

```bash
sudo install -m 640 -g github-runner /tmp/backend.env  /etc/request-management/.backend.env
sudo install -m 640 -g github-runner /tmp/frontend.env /etc/request-management/.frontend.env
```

> These paths are absolute and belong to the machine, not to an account, so moving the runner
> to a different user needs no change to `env_file` — only the group on the two files. Earlier
> revisions kept them under a home directory (`~/docker-env/`, and before that a hard-coded
> `/home/<user>/`), and every move left the other half of the docs pointing at the old place.

> **The trap worth naming.** `USER_SERVICE_URL` appears in both files and means opposite
> things. core-service wants `http://rm-user:3001/api/v1` — the prefix is part of the
> value. The frontend wants `http://rm-user:3001` — an origin, because
> `src/lib/backend.ts` appends `/api/v1` itself. Copying the line from one file to the other
> breaks whichever side receives it.
>
> `RUN_NUMBER_SERVICE_URL` is the same trap a second time: the backend file wants
> `http://rm-runnumber:3004/api/v1`, the frontend file wants `http://rm-runnumber:3004`.
> Miss it in the backend file and every document number fails; miss it in the frontend
> file and the "เลขรันเอกสาร" screen cannot load.

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

Open **3500** to whoever uses the app. 3501, 3502 and 3504 only need to be reachable from
the VM itself — the frontend and the services talk to each other over the `rm-net` network,
not through the host. **3504 in particular must stay closed**: run-number-service issues
document numbers and has no business being reachable from outside.

**3503 is the exception, and it is the whole point of external-service.** Its callers are
outside this machine — a chatbot, the Lead intake web form, the workflow engine, an MCP
client — and none of them is on `rm-net`, so they arrive through the host. A closed 3503
means every integration fails while the app itself looks healthy.

How far to open it is a decision for whoever runs the VM, and it is not the same decision as
3500: this port is the machine-facing API, reached with an `rfk_…` key or a service-account
token. Open it to the networks those callers actually come from, not wider. `PUBLIC_BASE_URL`
in `.backend.env` must name the address they use, or MCP discovery hands them the wrong one.

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
#    with "env file … not found", which reads like the file is missing. The
#    script separates the two, and every other way this path can break, and
#    prints the fix for each. Run it from a runner work directory.
#
#    `sudo -u github-runner` is load-bearing: as root it reads every file
#    regardless of mode, so a bare `sudo` passes the exact 600 file that fails
#    the deploy.
sudo -u github-runner bash scripts/check-labs-env.sh /etc/request-management/.backend.env
sudo -u github-runner bash scripts/check-labs-env.sh /etc/request-management/.frontend.env

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
curl -s localhost:3504/api/v1/health     # same, run-number-service
```

`/health` on core-service answers **200 even when the database is down** — the failure shows
only in the body. user-service's `/health` is static and says `ok` regardless. That is why the
compose healthchecks and the workflow's verify step both grep the body instead of trusting a
status code.
