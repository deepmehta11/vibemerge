# MergeProof controlled golden-PR runbook

This runbook is the **first live, deployment-controlled proof** of the
MergeProof automatic-merge path. It is intentionally narrow: one purpose-made
repository, one protected target branch, one low-risk pull request, and no
unrelated queue traffic. It is not evidence that MergeProof has been run live
already.

The target outcome is a GitHub merge that is attributable to this exact chain:

```text
signed GitHub delivery
  -> durable inbox
  -> PR-head "MergeProof / evidence" Check Run
  -> expected-head merge-queue admission
  -> signed merge_group delivery
  -> merge-group sandbox verification
  -> final source-pinned "MergeProof / evidence" Check Run
  -> GitHub performs the merge
```

MergeProof never calls a direct GitHub REST merge endpoint in production
merge-queue mode. A successful final Check Run is only a gate; GitHub owns the
eventual merge.

## 1. Scope and stop conditions

Use a dedicated fixture repository or an isolated protected branch. Do not run
this against a production branch, a shared merge queue, a large PR, or a PR
that changes MergeProof's trusted harness, trusted probes, policy, or
deployment configuration.

Before starting, name one operator who can remove the PR from GitHub's merge
queue and one operator who can disable the deployment. Stop immediately and
do **not** retry the PR automatically if any of these occur:

- the repository, target branch, App ID, required Check Run name, or required
  Check Run source differs from the approved configuration;
- a Check Run is missing, is from an unexpected App, is attached to an
  unexpected SHA, or has an unexpected conclusion;
- a sandbox receives a GitHub token, has egress, uses a mutable E2B template,
  or executes a PR-provided probe/command;
- a direct merge is observed or enabled;
- any PR other than the controlled PR enters the queue; or
- evidence cannot be correlated by delivery ID, PR number, exact SHA, and
  Check Run external ID.

## 2. Required external prerequisites

Complete and record every item before enabling automatic merge. Do not place
secret values in this runbook, a PR, a shell history, a policy file, or a
ticket.

### Repository and GitHub App

- Register/install the private App from
  [`config/github-app.manifest.template.json`](config/github-app.manifest.template.json)
  with its webhook URL pointing at `/webhooks/github` on the controlled
  deployment.
- Install the App only on the fixture repository. Confirm the manifest's
  events include `pull_request`, `pull_request_review`, `issues`,
  `check_run`, and `merge_group`.
- Give the App only the permissions declared in the manifest: Administration
  read, Checks write, Contents read, Issues write, Merge queues read, and
  Pull requests write.
- Enable GitHub's merge queue for the target branch. Configure branch
  protection/rules so direct merging is blocked and queue checks run for
  `merge_group`.
- In branch protection, require **every** `merge.requiredChecks` Check Run by
  its exact trusted App ID and require `MergeProof / evidence` from the
  MergeProof App ID. Do not use a legacy commit-status context as a substitute
  for a source-pinned Check Run.
- Keep unrelated PRs out of the queue for the entire exercise.

### Deployment and trusted verification material

- Build and test the exact revision to be deployed:

  ```bash
  npm run preflight
  docker build -t mergeproof .
  ```

- Mount deployment-owned policy, harness specification, and trusted probe
  files. Their required paths and non-secret configuration shape are in
  [`config/mergeproof.env.example`](config/mergeproof.env.example). The probe
  code must be outside the PR archive; the controller-owned harness is
  [`harness/mergeproof-harness.mjs`](harness/mergeproof-harness.mjs).
- Use an immutable `MERGEPROOF_E2B_TEMPLATE` of the form
  `<template>:<build-id>`, no aliases or tags. Supply credentials only through
  the deployment secret manager: GitHub App ID/private key/webhook secret,
  OpenAI key, and E2B key.
- Put the SQLite database on the persistent volume specified by
  `MERGEPROOF_DB_PATH`. This runbook is for the single-replica POC; do not
  horizontally scale that ledger.
- Start with `autoMergeEnabled: false` in the deployment-managed policy. Once
  all read-only checks below pass, change only that field to `true`, redeploy,
  and retain the exact policy digest/revision used for this run.
- Before accepting GitHub traffic, run configuration validation using the
  deployment's real mounted files and environment:

  ```bash
  npm run config:check
  npm run github:activation-check
  ```

  The activation check is read-only. It must confirm the complete
  source-pinned branch-protection set; it does not prove delivery, queue, or
  merge behavior.
- Confirm the deployed service reports `200` from both `/healthz` and
  `/readyz`. Do not shift webhook traffic while `/readyz` is `503`.
- Optionally validate the configured E2B account without a source upload:

  ```bash
  npm run e2b:smoke
  ```

### Controlled PR

- Create a tiny PR with one intentional, trusted fixture bug fix. It must be
  independently observable: the maintainer-owned reproduction fails on the
  base revision and passes on the candidate.
- Ensure trusted protected, adversarial, changed-hunk-closure, and resource
  probes have deterministic pass expectations for the fixture. If
  Issue-to-Proof is enabled, include the configured canonical `Fixes #...`
  linkage and leave that issue unchanged throughout the run.
- Obtain all normal review approvals and required labels. Wait until every
  trusted CI Check Run has completed successfully on the PR head. Record the
  PR's base SHA, head SHA, GitHub test-merge SHA (when available), base branch,
  required Check Run names/App IDs, and approval/label state.

## 3. Execution and expected evidence

At every checkpoint, record only sanitized identifiers and GitHub URLs: UTC
time, delivery ID, repository, PR number, SHA, Check Run ID/external ID/name,
conclusion, queue state, and merge commit SHA. Do not capture raw webhook
bodies, App JWTs, installation tokens, sandbox output, model text, issue body,
or secret-bearing environment values.

### A. Signed webhook reaches a durable inbox

1. With the policy still disabled, make a harmless PR metadata change (for
   example, add and remove a non-policy label) and confirm the GitHub delivery
   reaches `POST /webhooks/github`.
2. The expected HTTP result for a valid new delivery is `202` with
   `accepted: true` and its delivery ID. A duplicate delivery is rejected
   without executing the work again. An invalid signature must receive `401`.
3. Restore the controlled PR's required labels/approvals and ensure it is not
   queued. Set `autoMergeEnabled: true`, deploy that one policy change, and
   verify `/readyz` remains `200`.
4. Trigger the actual evaluation with a normal GitHub PR event (for example,
   push the final approved fixture commit or use GitHub's webhook redelivery).
   Record the delivery ID and the deployment log's corresponding
   `webhook_processed` record.

Expected result: the delivery is authenticated before it is durable; accepting
the webhook alone does not start a sandbox on the HTTP request or prove merge
eligibility.

### B. PR-head evidence Check Run

1. Wait for the worker to reload GitHub state and run the exact base/candidate
   verification. It must use the controller-mounted trusted harness and
   probes, with a no-egress E2B sandbox and no GitHub token in that sandbox.
2. In GitHub, inspect the Check Run on the **recorded PR head SHA**:
   - name: `MergeProof / evidence`;
   - producer: the expected MergeProof App;
   - external ID: the ledgered `check_run_publish:<run-key>` identity;
   - conclusion: `success` only for a sealed `LOW_OBSERVED_RISK` receipt.
3. Confirm the one managed MergeProof PR comment (if comments are enabled)
   refers only to the current sealed summary and contains no raw sandbox/model
   output.

Expected result: a success Check Run is evidence of the exact PR-head receipt,
not permission to bypass the queue. Any missing issue binding, changed live
state, failed probe, malformed metric, failed CI, missing approval/label, or
policy mismatch must produce a non-success outcome and no queue admission.

### C. Exact-head merge-queue admission

1. Confirm GitHub shows the recorded PR in the merge queue only after the
   successful PR-head Check Run.
2. Correlate the queue entry to the same PR head SHA. MergeProof's enqueue
   request is guarded with GitHub's `expectedHeadOid`; a new push must make
   admission fail or force fresh evidence rather than queue the old receipt.
3. Confirm no direct merge request has been made. The queue entry, not a REST
   merge result, is the expected transition.

Expected result: exactly one queue entry for the controlled PR. If its
approvals, labels, required CI, base/head/test-merge revision, or sealed issue
context changes later, MergeProof removes the stale entry before new evidence
may be queued.

### D. Signed `merge_group` verification

1. Wait for GitHub to generate the queue SHA and send
   `merge_group` with action `checks_requested` to `/webhooks/github`.
2. Record the new delivery ID, merge-group base SHA, and merge-group head SHA.
   The expected intake result is again `202` only after signature verification
   and durable storage.
3. Verify the worker asks GitHub for every PR associated with that merge-group
   commit. For this controlled run, the association must contain only the
   golden PR. It must find a still-queued, sealed PR receipt and revalidate its
   approvals, labels, CI, exact revisions, and canonical issue digest.
4. Confirm E2B verifies the **merge-group SHA**, not merely the PR head SHA.

Expected result: an association ambiguity, a missing/stale PR receipt, a
second unexpected PR, a failed sandbox verification, or a changed live policy
results in a failed final Check Run. It must not fall back to the PR-head
receipt.

### E. Final source-pinned Check Run and GitHub merge

1. Immediately before final publication, MergeProof rereads the target
   branch's protection. Confirm the policy-required CI Check Runs and
   `MergeProof / evidence` remain exact name-and-App-ID requirements.
2. Inspect the final Check Run on the **merge-group head SHA**:
   - name: `MergeProof / evidence`;
   - producer: the expected MergeProof App;
   - external ID: a distinct `check_run_publish:<merge-group-run-key>`;
   - conclusion: `success` only after the final source-pin and participant
     revalidation succeeds.
3. Let GitHub process the required queue checks. Record the queue's final
   status and GitHub's resulting merge commit SHA.
4. Confirm the merged commit contains the controlled PR and that its parent or
   merge-group lineage matches the recorded queue result. Confirm no additional
   PR was merged as part of this exercise.

Expected result: GitHub performs the eventual merge after the final successful
Check Run. MergeProof never issues a direct merge command and never treats a
model result as authorization.

## 4. Safe abort and failure handling

### Immediate abort

1. Remove the golden PR from GitHub's merge queue first. Convert it to draft
   or close it if needed to prevent a new queue admission.
2. Use the authenticated Operator Console's **Pause automation** action (or
   `POST /api/operator/v1/automation/pause` with Basic auth and
   `X-MergeProof-Operator-Action: pause`) to durably stop future MergeProof
   token minting, sandbox work, Check Runs, queue admissions, and merge-group
   success signals without waiting for a redeploy. This does not retroactively
   remove a GitHub queue entry, which is why the first step comes first.
3. Set `autoMergeEnabled: false` in the deployment-managed policy and deploy
   it as the durable configuration rollback. Verify `/readyz` after deployment.
4. If the deployment itself is suspected, suspend/remove the App's access to
   the fixture repository or stop webhook traffic. Keep branch protection and
   the merge queue enabled so direct merges remain blocked.
5. Preserve only sanitized correlation data. Do not copy raw delivery bodies,
   credentials, sandbox archives, issue text, or agent output into incident
   material.

### Expected fail-closed behaviors

| Observation | Required safe result |
| --- | --- |
| Invalid webhook signature | `401`; no durable event and no work. |
| Inbox saturation or draining instance | `503` with retry guidance; GitHub retries instead of work being accepted unsafely. |
| E2B, trusted-probe, metric, issue-binding, CI, approval, or label failure | No successful evidence receipt; no queue admission. |
| PR head/base/test-merge or linked-issue digest changes | Stale queue entry is removed; fresh evidence is required. |
| GitHub has removed a previously queued entry | MergeProof revokes the local state and does not blindly re-enqueue it. |
| `merge_group` association/policy/source-pin failure | Final Check Run is failure; GitHub blocks or removes the queue entry. |
| Crash after a journaled Check Run creation | Reconciliation performs exact readback. A stranded known Check Run may be closed as failure; a recovered green PR-head check grants no queue authority and requires a fresh evidence run. |
| Crash after queue admission intent | Reconciliation reads exact GitHub state; it never retries a merge or blindly re-enqueues. |

Do not force a green Check Run, manually create a same-named Check Run, patch a
receipt, replay a webhook with an altered body, or use a direct merge API to
"finish" the run. Treat any such action as an invalid golden run and start
again from a new controlled PR.

## 5. Closeout record and rollback

Mark the golden run successful only when all of the following are present:

- a signed PR-trigger delivery and signed `merge_group` delivery were accepted
  durably;
- the PR-head and merge-group Check Runs have the expected App identity, exact
  SHA, expected external IDs, and `success` conclusions;
- the controlled PR was seen in GitHub's queue and no unrelated PR was part of
  its merge group;
- the final branch-protection source-pin check was observed before the final
  Check Run; and
- GitHub, not MergeProof, produced the recorded merge commit.

After capturing this evidence, set `autoMergeEnabled: false` again, remove the
fixture App installation or restrict it back to the fixture repository, and
archive the sanitized run record. Keep the policy/probe/template digests with
the record; any later change to those inputs requires a new golden run.

For implementation details behind these controls, see
[`README.md`](README.md), [`src/webhook-server.ts`](src/webhook-server.ts),
[`src/controller.ts`](src/controller.ts),
[`src/merge-group-controller.ts`](src/merge-group-controller.ts), and
[`src/reconciliation-worker.ts`](src/reconciliation-worker.ts).
