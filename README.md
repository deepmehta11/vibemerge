# MergeProof

MergeProof is an evidence-first controller for automatic pull-request merging. It treats a PR as mergeable only when a pinned base/head/policy revision has an immutable verification receipt and a final live preflight still matches that exact revision.

This first vertical slice is intentionally narrow and runnable:

- a SQLite run ledger deduplicates webhook deliveries, fences stale workers, atomically caps retained webhook count and bytes, records an intent before merge-enabling GitHub writes, schedules deferred/transient retries with durable backoff, and fairly rotates eligible repositories so one busy repository cannot consume every local worker slot;
- a deterministic verifier compares base and candidate behavior, protected regression checks, adversarial cases, changed-hunk closure, and resource thresholds;
- a fixture harness demonstrates safe merge, incomplete proof, and infrastructure regression outcomes without external credentials;
- an automatic merge broker performs a final exact-head preflight and records a merge attempt before calling a narrowly scoped gateway;
- E2B executes an exact base or merge-candidate source archive in a no-egress sandbox, using immutable controller-mounted probes that the PR cannot replace;
- two bounded OpenAI agents compile a fixed-DSL, non-executable Issue-to-Proof plan before verification; when configured, an unavailable or invalid plan can only fail closed to review, while deterministic evidence remains the only authority that can establish low observed risk;
- a bounded worker pool keeps several verifications active without unbounded E2B concurrency, while a single managed PR comment and optional read-only Operator Console explain sealed deterministic evidence without exposing candidate-controlled output.

It does **not** claim that a model score is proof. Agents may propose bounded structure transiently, but model prose is discarded before receipt sealing or sandbox guidance; deterministic policy and observed evidence are the only merge authority.

## Run locally

```bash
npm install
npm run preflight
npm run demo
```

The demo uses a deterministic local fixture provider. It never contacts GitHub, OpenAI, or E2B, and it never merges a real PR.

To exercise the single-replica inbox at the MVP target backlog, run:

```bash
npm run scale:smoke
```

It accepts, fairly claims, lease-fences, and completes 1,000 synthetic signed-delivery envelopes across ten repositories and up to 32 local worker identities. It deliberately makes no GitHub or E2B calls, so it validates durable inbox capacity and scheduling—not 1,000 concurrent sandboxes or a horizontally scaled deployment. Set `MERGEPROOF_SCALE_EVENTS`, `MERGEPROOF_SCALE_REPOSITORIES`, or `MERGEPROOF_SCALE_WORKERS` only for a bounded local drill.

Before exposing a configured service to GitHub, run the startup-only validation command with the same deployment-managed environment values that the service will receive:

```bash
npm run config:check
```

It validates policy structure, trusted local paths, and required startup credentials without opening a port or making a GitHub, OpenAI, or E2B request. A non-secret environment shape is included in [mergeproof.env.example](config/mergeproof.env.example); copy its keys into a secret/configuration manager rather than committing a filled `.env` file.

Once the GitHub App is installed, run the read-only activation check with `MERGEPROOF_ACTIVATION_INSTALLATION_ID`, `MERGEPROOF_ACTIVATION_REPOSITORY`, and `MERGEPROOF_ACTIVATION_BRANCH` set in the deployment secret manager:

```bash
npm run github:activation-check
```

It reads the same `MERGEPROOF_POLICY_PATH` used by the service, mints only `administration:read`, and verifies that target branch protection requires every policy-required CI Check Run by its exact App ID **plus** the final `MergeProof / evidence` Check Run from this App. It makes no GitHub write. The policy must therefore map every `merge.requiredChecks` name in `merge.requiredCheckAppIds`; an incomplete map fails before the GitHub read. It intentionally cannot prove that direct merges are blocked or that a real `merge_group` delivery will arrive; those require the controlled [golden-PR runbook](GOLDEN_PR_RUNBOOK.md).

To test only the E2B connection and cleanup lifecycle, set a freshly rotated `E2B_API_KEY` in your shell or deployment secret manager, then run:

```bash
npm run e2b:smoke
```

The smoke test creates one no-egress sandbox, runs a fixed command, and kills it in `finally`. It does not upload source or contact GitHub.

## Live boundary

`src/e2b-harness.ts` downloads the exact base SHA or GitHub-generated merge SHA on the controller with a read-only installation token, then uploads that archive into a short-lived, no-egress E2B sandbox. The token is never uploaded. It also uploads the fixed [trusted harness](harness/mergeproof-harness.mjs) and a maintainer-owned probe specification; the checked-out PR cannot replace either.

The harness rejects links, special files, oversized expanded archives, and source-controlled shell commands. It extracts the source into a fresh directory and runs only `.mjs` probes mounted at `/workspace/probes` by the controller. A probe receives `MERGEPROOF_SOURCE_DIR` and may exercise that candidate source, but its own executable code and regression fixtures must stay outside the PR archive. A validated Issue-to-Proof plan is mounted only as JSON at `MERGEPROOF_ADVISORY_PLAN_PATH`; probes may read it as guidance but cannot execute model-authored code. `config/mergeproof.harness.example.json` intentionally points to a fail-closed probe; replace it with repository-specific trusted probes before enabling automatic merge. Bug reproduction should exit non-zero on the base and zero on the candidate; protected, adversarial, hunk-closure, and deterministic gates must pass in both.

Each resource probe must print exactly one finite, non-negative numeric value. A metric may opt into a sealed `workloadProfile`, for example `{ "repetitions": 5, "aggregation": "max" }`. The controller runs the same immutable probe and fixed arguments for every sample, with a one-based `MERGEPROOF_WORKLOAD_ITERATION` and fixed `MERGEPROOF_WORKLOAD_REPETITIONS` derived only from the specification. Profiles require 2–10 runs, can use only conservative `max` aggregation (every resource threshold is an upper bound), and must fit in a five-minute total probe budget. A failed or malformed sample produces no metric and therefore fails closed; raw per-run output is not retained for profiled metrics. Existing metrics without `workloadProfile` retain their single-run behavior. At startup, MergeProof sums every trusted probe deadline for one base or candidate phase, adds the harness's 150-second archive budget and a two-minute E2B setup/upload allowance, then sets that exact sandbox lifetime. The aggregate trusted probe schedule is capped at 20 minutes (a 24½-minute maximum sandbox), and the durable verification lease adds a further five-minute controller allowance; an over-budget or malformed timing specification prevents startup. Production requires an immutable E2B selector in the form `<template>:<build-id>`; aliases and tags are rejected. The runtime hashes that selector, the trusted command, and the exact harness/spec/probe bytes into every policy/run identity, so changing any of them forces fresh evidence.

`src/agent-planner.ts` runs a no-tool Claim Compiler and Patch Skeptic through the OpenAI Agents SDK. They use `gpt-5.4` by default, or `MERGEPROOF_PLANNER_MODEL` / `MERGEPROOF_SKEPTIC_MODEL` if set. Credential-shaped input and output are redacted. Before sandbox collection, agents can propose only fixed scenario kinds (`base_fails_candidate_passes`, `both_revisions_pass`, and `candidate_not_worse`) against policy-owned obligation IDs. The verifier revalidates that structure, replaces model-authored IDs and prose with fixed metadata, and never lets an advisory result elevate a deterministic verdict. When `verification.issueToProof.requireLinkedIssue` is enabled, the controller follows an explicit `Fixes #123` link through its installation-scoped read gateway, bounds and sanitizes the canonical issue title/body for the planner, and seals only its digest plus byte-count metadata into the receipt. That digest is part of the pinned revision, so changed issue content produces a different proof identity. Missing linkage, issue retrieval, proof obligations, or a planner result fails closed to human review.

The local service implements merge-queue-native verification. It publishes the sealed PR receipt as a Check Run on the PR head, enqueues only that same head with GitHub's `expectedHeadOid` guard, then independently verifies the queue-generated `merge_group` SHA. Before the final Check Run can pass, GitHub's associated-PR view of that SHA must contain only PRs with still-queued, current MergeProof receipts; each is rechecked for approvals, labels, required CI, exact base/head/test-merge revisions, and canonical Issue-to-Proof digest. The final gate also rereads branch protection and requires every policy-owned CI Check Run plus `MergeProof / evidence` by exact name and GitHub App ID immediately before publishing success, so a policy or source drift after enqueue fails the group check. GitHub—not MergeProof—performs the eventual merge. The runtime never enables direct REST auto-merge; `direct_fixture` exists only in injected tests and demos. Each later PR, review, or relevant-CI trigger reloads live state: if approvals, labels, required CI, the tested revision, or sealed Issue-to-Proof digest changed, MergeProof removes the old queue entry before any fresh proof can be queued. Even when that state is unchanged, it read-checks the exact queue membership; an entry GitHub has removed is revoked locally and is never silently re-enqueued.

## Important production constraint

The direct GitHub REST merge endpoint can guard the PR head SHA, but it cannot atomically pin the evaluated base SHA in the same merge request. Do not treat `GitHubRestGateway` as the production merge path for an exact base/head proof. `mergeStrategy: "merge_queue"` is the production path: a base change or another queued PR produces a new `merge_group` SHA and forces a new receipt before GitHub can merge.

## GitHub controller path

The implementation now includes the production-facing control-plane primitives:

1. [webhook-server.ts](src/webhook-server.ts) verifies the raw GitHub signature and writes an inbox event to SQLite before returning `202`.
2. [controller.ts](src/controller.ts) reloads PR state with a read-only token, verifies base versus GitHub's test-merge candidate, rechecks the exact revision plus approvals, labels, and required CI, then publishes the receipt as `MergeProof / evidence` on the PR head.
3. After a sealed `LOW_OBSERVED_RISK` receipt and final live-policy preflight, [merge-queue.ts](src/merge-queue.ts) enqueues the PR with GraphQL `expectedHeadOid`; it never calls the direct REST merge API in queue mode. In production, it also refuses to queue unless the base branch requires the exact `MergeProof / evidence` Check Run from this GitHub App, preventing a same-named check from another App from satisfying the final merge-group proof.
4. [merge-group-controller.ts](src/merge-group-controller.ts) consumes `merge_group.checks_requested`, asks GitHub which open PRs are associated with the queue SHA, rechecks their queued receipts and live policy, verifies the actual queue SHA in E2B, and revalidates source-pinned branch protection immediately before publishing the final Check Run. Any missing, stale, ineligible, or protection-drifted associated PR—or a non-low-risk result—is a failed Check Run, so GitHub removes or blocks the queue entry.
5. [github-comment.ts](src/github-comment.ts) upserts one detailed comment per PR. It verifies the comment belongs to the current GitHub App identity before editing it, never renders untrusted sandbox command output, and shows only sealed Issue-to-Proof identifiers plus trusted base/candidate observations—not issue text or agent assertions. If later live state revokes a queue entry, the same comment is best-effort updated to say it was removed and why.
6. The bounded worker pool either completes the event, retries a transient failure with exponential backoff, or defers a missing GitHub merge candidate for five seconds without losing the delivery or consuming the retry budget. Its durable dispatcher selects the oldest eligible event for the repository least recently claimed, so a busy repository cannot monopolize slots within this single ledger. The durable inbox defaults to a 10,000-event and 256 MiB active-payload cap; saturation returns `503 Retry-After` so GitHub retries. After three failed attempts, one delayed (five-minute) dead-letter re-drive is scheduled even if GitHub sends no new delivery; that bounded record remains inside the same capacity limit and retains its signed payload only until it succeeds or fails for the final time, when the body is erased. Before every Check Run, merge-enabling queue, or fixture merge write, the ledger persists an exact operation identity. After a process crash, recovery first waits for the original publisher lease to expire and then performs only exact readback: it can settle a proven queue admission or fixture merge, or record a completed Check Run. A recovered green PR-head Check Run grants no merge authority; it can be reused only after a new evidence run and a fresh live preflight, and recovery itself never enqueues. Its single write exception remains tightly constrained: an exact journaled Check Run still observed `in_progress` after expiry is completed as **failure** with a fresh `checks:write` token. A queue entry that is no longer present on a later live check is revoked locally and left for a fresh GitHub-triggered evaluation, never blindly re-enqueued.

`config/mergeproof.policy.example.json` is a maintainership-owned policy shape. Replace its illustrative `requiredCheckAppIds` values with the exact Apps that own each CI Check Run before running activation validation or enabling queue automation. Keep `autoMergeEnabled` false until the fixture repository is protected and uses merge-queue-native MergeProof checks.

For a GitHub App integration, copy [github-app.manifest.template.json](config/github-app.manifest.template.json), replace `YOUR_DEPLOYMENT_HOST`, and register it as a private GitHub App. It subscribes to `pull_request`, `pull_request_review`, `issues`, `check_run`, and `merge_group`: an approval, edited PR description, edited linked issue, or completed CI check re-evaluates a previously ineligible PR from fresh GitHub state. An issue edit is resolved only against MergeProof's currently queued, sealed issue references; its title/body remain transient and are reloaded through the App's read token before any queue action. A completed check run associated with several PRs re-evaluates each linked PR sequentially, keeping its webhook payload out of the merge decision. The App requests only the needed Contents read, Pull requests write, Issues write, Checks write, Merge queues read, and Administration read permissions; the last one is used only to confirm that branch protection requires this App's final evidence check. GitHub App manifests declare these permissions, events, and webhook URL together; GitHub documents the manifest format [here](https://docs.github.com/en/apps/creating-github-apps/creating-github-apps/creating-a-github-app-from-a-manifest). The controller generates RS256 App JWTs and requests a fresh installation token scoped to one repository and the minimum permissions for the current step; E2B receives no GitHub token. GitHub requires queue checks to run against the distinct [`merge_group` event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group).

## Local service configuration

`npm start` loads a local ignored `.env` if present. The service requires these deployment-managed values: `MERGEPROOF_POLICY_PATH`, `MERGEPROOF_E2B_TEMPLATE`, `MERGEPROOF_HARNESS_COMMAND` (normally `node /workspace/mergeproof-harness.mjs`), `MERGEPROOF_TRUSTED_HARNESS_PATH`, `MERGEPROOF_TRUSTED_PROBES_DIR`, `MERGEPROOF_HARNESS_SPEC_PATH`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, and `OPENAI_API_KEY`. `E2B_API_KEY` is required only when a queued run starts. `MERGEPROOF_WORKER_CONCURRENCY` defaults to `2` and is capped at `32`; set it to the E2B capacity you have budgeted. `MERGEPROOF_RECONCILIATION_CONCURRENCY` also defaults to `2` and is capped at `16`; its slots use unique fenced worker IDs and renew their leases while GitHub reads or the failure-only Check Run close is in flight. `npm run config:check` validates both values before traffic is accepted. `MERGEPROOF_MAX_PENDING_WEBHOOK_EVENTS` and `MERGEPROOF_MAX_PENDING_WEBHOOK_BYTES` default to `10,000` and `268435456`; tune both to the persistent-volume and retry budget. Keep every secret in the deployment secret manager, never in policy JSON, a PR, sandbox workspace, receipt, or log.

Policy files are strict: unknown keys, duplicate repository/check/metric names, missing thresholds for required metrics, Issue-to-Proof obligations outside `requiredCheckIds`, App-ID pins for non-required checks, and `MergeProof / evidence` placed in `merge.requiredChecks` cause startup validation to fail. The evidence Check Run is emitted only after PR verification, so it belongs in source-pinned branch protection as the final merge-group gate, never among the PR checks it waits for. This is intentional—an operator typo must not silently weaken or deadlock a merge policy.

### Operator Console

Set `MERGEPROOF_OPERATOR_CONSOLE=true` and a deployment-managed `MERGEPROOF_OPERATOR_TOKEN` (at least 24 characters) to enable the console at `GET /ops`. It uses same-origin HTTP Basic authentication with username `operator`; serve it only behind TLS. The console exposes sanitized receipt summaries, deterministic checks/metrics, queue health, and reconciliation-required run states with `Cache-Control: no-store` and no CORS headers. Its only mutation is a durable emergency pause/resume control: `POST /api/operator/v1/automation/pause` or `/resume` requires Basic auth plus `X-MergeProof-Operator-Action: pause|resume`, preventing a cross-site form from triggering it. A pause blocks new GitHub tokens, sandbox runs, Check Runs, queue admissions, and merge-group success signals. It does **not** retroactively dequeue an already-admitted PR or undo a GitHub merge that has already begun: remove queued PRs in GitHub first, then pause. Resuming never reuses an old receipt or re-enqueues a PR; a normal new GitHub trigger and fresh evidence are required. The console has no merge, retry, policy-edit, token, raw-webhook, PR-body/diff, sandbox-log, or model-text endpoint.

For an isolated source-upload smoke test, run `npm run e2b:harness:smoke`. It creates two no-egress E2B sandboxes, verifies a base bug reproduction and candidate fix from uploaded tarballs, measures a fixture metric, and always destroys both sandboxes.

## Deploy

The included [Dockerfile](Dockerfile) creates a production image that runs as the unprivileged `node` user and declares a Docker `HEALTHCHECK` against `GET /healthz`. Its [.dockerignore](.dockerignore) excludes `.env*` files and local SQLite/DB artifacts so a developer's credentials or ledger cannot enter the build context. Use `GET /healthz` as liveness. Use `GET /readyz` for readiness: it returns `503` while the process is draining after `SIGTERM`/`SIGINT`, before it stops accepting webhook traffic and waits for active work to settle. Startup and webhook lifecycle events are emitted as small JSON log records without secrets or raw webhook bodies. Build it with:

```bash
docker build -t mergeproof .
```

Mount or inject the maintainer-owned policy, harness specification, and repository-specific trusted probe directory, then set `MERGEPROOF_POLICY_PATH`, `MERGEPROOF_HARNESS_SPEC_PATH`, `MERGEPROOF_TRUSTED_HARNESS_PATH=/app/harness/mergeproof-harness.mjs`, and `MERGEPROOF_TRUSTED_PROBES_DIR`. Use `MERGEPROOF_DB_PATH=/app/data/mergeproof.sqlite` with a persistent volume. SQLite is intentionally a single-replica POC ledger: a real 1,000-PR deployment needs a shared transactional database and queue before it is horizontally scaled. Keep `autoMergeEnabled: false` until the GitHub App is installed, the branch requires a merge queue, and `MergeProof / evidence` is a required check from this App. When enabling production merge-queue mode, map every `merge.requiredChecks` name to the trusted Check Run App ID in `merge.requiredCheckAppIds`; the runtime rejects source-unpinned production policies. Do not put secrets in the container image or the policy/specification files.

Run `npm run config:check` locally, or `node dist/config-check.js` inside the built image, using the exact values and mounted files intended for the deployment. Only shift GitHub webhook traffic after that command succeeds and `/readyz` returns `200`. For rolling deployments, configure a termination grace period longer than the derived sandbox lifetime plus the E2B cleanup allowance; otherwise the ledger's expired lease will retry the evidence run after the old process is terminated.
