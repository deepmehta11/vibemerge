import type { MergeProofController } from "./controller.js";
import type { MergeGroupController } from "./merge-group-controller.js";
import {
  parseGitHubWebhook,
  type GitHubWebhookParseOptions,
  type PullRequestTrigger,
} from "./github-webhook-event.js";
import type { RunLedger, WebhookJob } from "./ledger.js";
import { startLeaseHeartbeat } from "./lease-heartbeat.js";

export interface WebhookWorkerResult {
  state: "idle" | "processed" | "retried" | "failed";
  deliveryId?: string;
  detail?: string;
}

/**
 * A single pull from the durable inbox. A host can schedule this in a worker
 * process, cron loop, or a managed queue consumer without changing merge logic.
 */
export class WebhookWorker {
  constructor(
    private readonly ledger: RunLedger,
    private readonly controller: Pick<MergeProofController, "process">,
    private readonly workerId: string,
    private readonly maxAttempts = 3,
    private readonly now: () => number = () => Date.now(),
    private readonly mergeGroups?: Pick<MergeGroupController, "process">,
    private readonly parseOptions: GitHubWebhookParseOptions = {},
    private readonly webhookLeaseMs = 30 * 60_000,
  ) {}

  async processNext(): Promise<WebhookWorkerResult> {
    const job = this.ledger.claimWebhook(this.workerId, this.webhookLeaseMs, this.now());
    if (!job) {
      return { state: "idle" };
    }
    const heartbeat = startLeaseHeartbeat(
      `Webhook ${job.deliveryId}`,
      () => this.ledger.renewWebhookLease(job.lease, this.webhookLeaseMs, this.now()),
      this.webhookLeaseMs,
    );
    try {
      let body: unknown;
      try {
        body = JSON.parse(job.body);
      } catch {
        heartbeat.assertHealthy();
        this.ledger.failWebhook(job.lease, "Webhook body is not valid JSON.", this.now());
        return { state: "failed", deliveryId: job.deliveryId, detail: "Invalid JSON." };
      }
      const parsed = parseGitHubWebhook(job.deliveryId, job.eventName, body, this.parseOptions);
      if (parsed.kind === "ignored") {
        heartbeat.assertHealthy();
        this.ledger.completeWebhook(job.lease, this.now());
        return { state: "processed", deliveryId: job.deliveryId, detail: parsed.reason };
      }
      if (parsed.kind === "pull_request" || parsed.kind === "pull_requests") {
        const triggers = parsed.kind === "pull_request" ? [parsed.trigger] : parsed.triggers;
        return await this.processPullRequestTriggers(job, heartbeat, triggers, "completed check run");
      }
      if (parsed.kind === "linked_issue") {
        const seen = new Set<number>();
        const triggers: PullRequestTrigger[] = [];
        for (const run of this.ledger.findQueuedRunsForLinkedIssue(
          parsed.trigger.repository,
          parsed.trigger.issueNumber,
        )) {
          const pullRequest = run.receipt?.revision.pullRequest;
          if (!pullRequest || seen.has(pullRequest)) {
            continue;
          }
          seen.add(pullRequest);
          triggers.push({
            deliveryId: parsed.trigger.deliveryId,
            action: "linked_issue_edited",
            installationId: parsed.trigger.installationId,
            repository: parsed.trigger.repository,
            repositoryId: parsed.trigger.repositoryId,
            pullRequest,
          });
        }
        return await this.processPullRequestTriggers(job, heartbeat, triggers, "linked issue edit");
      }
      const outcome = this.mergeGroups
        ? await this.mergeGroups.process(parsed.trigger)
        : (() => {
            throw new Error("Merge-group delivery received but no merge-group controller is configured.");
          })();
      heartbeat.assertHealthy();
      this.ledger.completeWebhook(job.lease, this.now());
      return { state: "processed", deliveryId: job.deliveryId, detail: outcome.state };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown worker failure.";
      if (job.attempt >= this.maxAttempts) {
        heartbeat.assertHealthy();
        this.ledger.failWebhook(job.lease, detail, this.now());
        return { state: "failed", deliveryId: job.deliveryId, detail };
      }
      heartbeat.assertHealthy();
      this.ledger.retryWebhook(job.lease, detail, this.now());
      return { state: "retried", deliveryId: job.deliveryId, detail };
    } finally {
      heartbeat.stop();
    }
  }

  private async processPullRequestTriggers(
    job: WebhookJob,
    heartbeat: { assertHealthy(): void },
    triggers: PullRequestTrigger[],
    source: string,
  ): Promise<WebhookWorkerResult> {
    if (triggers.length === 0) {
      heartbeat.assertHealthy();
      this.ledger.completeWebhook(job.lease, this.now());
      return { state: "processed", deliveryId: job.deliveryId, detail: `No queued pull request matched ${source}.` };
    }
    let waitingReason: string | undefined;
    let singleOutcome: string | undefined;
    // A check run or issue edit can resolve to multiple PRs. Keep re-evaluation
    // sequential so one webhook cannot multiply concurrent E2B workloads.
    for (const trigger of triggers) {
      const outcome = await this.controller.process(trigger);
      singleOutcome = outcome.state;
      if (outcome.state === "waiting" && !waitingReason) {
        waitingReason = outcome.reason;
      }
    }
    if (waitingReason) {
      heartbeat.assertHealthy();
      this.ledger.deferWebhook(job.lease, waitingReason, this.now());
      return { state: "retried", deliveryId: job.deliveryId, detail: waitingReason };
    }
    heartbeat.assertHealthy();
    this.ledger.completeWebhook(job.lease, this.now());
    return {
      state: "processed",
      deliveryId: job.deliveryId,
      detail:
        triggers.length === 1
          ? singleOutcome ?? "completed"
          : `re-evaluated ${triggers.length} pull requests after a ${source}`,
    };
  }
}
