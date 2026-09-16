# Deploying to labs

How a commit reaches the labs VM, and what to do when you are working on a different branch.

Machine-level setup — runner, Docker, env files, Keycloak — is a separate, one-time job:
[`labs-server-setup.md`](./labs-server-setup.md).

---

## What triggers a deploy

```yaml
on:
  push:
    branches: [deploys/labs]
  workflow_dispatch:
```

**GitHub reads the workflow file from the branch being pushed to.** `deploy-labs.yml` exists
only on `deploys/labs`, so:

- pushing to `main`, or to any feature branch, does **nothing** — the job is not skipped, the
  workflow is not visible at all
- a commit deploys only once it is sitting **on `deploys/labs`**

Both repos work this way and each deploys only its own containers:

| Repo | Deploys |
|---|---|
| `request-mangement-backend` | `rm-user`, `rm-core`, `rm-external` |
| `request-management-frontend` | `rm-fe` |

Merging into `deploys/labs` in one repo does not touch the other.

---

## What the pipeline does

```
push → deploys/labs
  │
  ├─ version            (ubuntu-latest)
  │     package.json version + short sha  →  tag, e.g. 1.0.0-a046161
  │     ↓
  ├─ build-and-push     (ubuntu-latest, matrix: user-service, core-service, external-service)
  │     docker build --platform linux/amd64
  │     docker login  →  push to swr.ap-southeast-2.myhuaweicloud.com
  │     ↓
  └─ deploy             (self-hosted runner on the VM)
        checkout  →  docker login  →  ensure the rm-net network
        docker compose up -d --pull always --wait
```

The frontend pipeline is the same shape without the matrix; it reads its tag inside
`build-and-push` because a single job can publish outputs and a matrix job cannot.

`version` is a job of its own so all three services get **one** tag. A matrix job cannot publish
outputs — each leg would overwrite the others and which one lands is undefined.

`--wait` holds the step until every healthcheck passes, so a container that starts and then
fails its check turns the deploy red instead of being reported as shipped.

---

## Working from another branch

```bash
git checkout -b feat/approval-ui main
# … edit, commit

git checkout deploys/labs
git merge feat/approval-ui
git push origin deploys/labs      # ← this line is the deploy
```

Or open a pull request with **base `deploys/labs`** and merge it — the merge commit is a push
to that branch, so it deploys the same way.

To redeploy the branch as it already stands, with no new commit: Actions → *Labs deploy* →
**Run workflow** (`workflow_dispatch`).

---

## Things that catch people out

| | |
|---|---|
| **The runner checks out from GitHub, not from your machine** | An edit that is not committed and pushed does not exist as far as the deploy is concerned. This has already cost one debugging round on the env-file path. |
| **Changes to compose, workflow, or Dockerfile behave the same** | They take effect when they land on `deploys/labs`, not when you save them. |
| **`concurrency: cancel-in-progress: true`** | Two pushes in quick succession leave only the newer run. Deliberate: overlapping deploys would fight over the same containers. |
| **No `paths:` filter** | Editing only a README still rebuilds and redeploys everything. Simpler to reason about than a filter that occasionally skips a build you needed. |
| **Container names are shared with the manual `docker run` commands** | compose will not adopt a container it did not create. Start one by hand and the next deploy stops with `Conflict. The container name "/rm-core" is already in use` — fix with `docker rm -f rm-user rm-core rm-external rm-fe`, then re-run. |
| **Image tags are `<version>-<short sha>`** | A tag is never pushed over, which is what makes re-running an old workflow a real rollback. |

---

## Rolling back

Open the Actions run for the commit you want and choose **Re-run all jobs**. Because tags are
immutable, that run pulls exactly the images it originally deployed.

Manually on the VM, if you know the tag:

```bash
IMAGE_TAG=1.0.0-abc1234 docker compose -f infra/labs/docker-compose.yml up -d --pull always --wait
```

---

## When a deploy fails

The `Debug on Failure` step already prints `docker compose ps` and the last 50 log lines. Past
that, on the VM:

```bash
docker compose -f infra/labs/docker-compose.yml ps
docker compose -f infra/labs/docker-compose.yml logs --tail=100 core-service
docker compose -f infra/labs/docker-compose.yml logs --tail=100 external-service

# the check that separates "running" from "actually working":
curl -s localhost:3502/api/v1/health     # must say "database":"up"
curl -s localhost:3503/api/v1/health     # same, external-service

# 3503 only: the address MCP clients are handed. Wrong host here and every
# integration still works while the MCP connect button fails on its own.
curl -s localhost:3503/.well-known/oauth-protected-resource
```

`/health` on core-service answers **200 even when the database is down** — the failure shows
only in the body. That is why the compose healthcheck greps the body rather than trusting a
status code, and why a deploy can hang on `--wait` with no obvious error: almost always the VM
cannot reach the database.

Two failures do **not** turn the deploy red, because they happen in use rather than at start:

- **Keycloak redirect URIs** that do not list the labs origin — login dies with
  *"Invalid parameter: redirect_uri"* on a green deploy
- **Pending migrations** — the services start against a schema they do not match, and queries
  fail one endpoint at a time

---

## `deploys/labs` is ahead of `main`

The deploy configuration and two fixes live only on this branch:

- `approval-context.client.ts` read a config key that does not exist (`services.userServiceUrl`
  instead of `userServiceUrl`) and always fell back to `localhost`, which in a container is
  core-service itself
- both service Dockerfiles copied `libs/share/dist`, a directory no build produces — it fails
  on any clean checkout, which is every CI run

A branch cut from `main` today inherits both. Merging `deploys/labs` back into `main` is
outstanding work, not something this pipeline does.
