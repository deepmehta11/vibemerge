export type PullRequestAction =
  | "opened"
  | "edited"
  | "closed"
  | "converted_to_draft"
  | "reopened"
  | "synchronize"
  | "ready_for_review"
  | "labeled"
  | "unlabeled"
  | "review_submitted"
  | "review_edited"
  | "review_dismissed"
  | "check_completed"
  | "linked_issue_edited";

export interface PullRequestTrigger {
  deliveryId: string;
  action: PullRequestAction;
  installationId: number;
  repository: string;
  repositoryId: number;
  pullRequest: number;
}

export interface MergeGroupTrigger {
  deliveryId: string;
  installationId: number;
  repository: string;
  repositoryId: number;
  baseSha: string;
  headSha: string;
}

/** A signed issue-edit coordinate; the worker resolves only its own queued PRs. */
export interface LinkedIssueTrigger {
  deliveryId: string;
  installationId: number;
  repository: string;
  repositoryId: number;
  issueNumber: number;
}

/**
 * Check-run deliveries are only scheduling hints. Filtering them at the
 * boundary prevents MergeProof's own Check Run (or unrelated CI) from
 * repeatedly spending sandbox capacity on an unchanged pull request.
 */
export interface CheckRunTriggerPolicy {
  requiredChecks: readonly string[];
  requiredCheckAppIds?: Readonly<Record<string, number>>;
  ownAppId?: number;
  ownCheckName?: string;
}

export interface GitHubWebhookParseOptions {
  checkRunPolicy?: CheckRunTriggerPolicy;
}

export type ParsedWebhookEvent =
  | { kind: "trigger"; trigger: PullRequestTrigger }
  | { kind: "ignored"; reason: string };

export type ParsedGitHubWebhookEvent =
  | { kind: "pull_request"; trigger: PullRequestTrigger }
  /** A completed check can be attached to more than one pull request. */
  | { kind: "pull_requests"; triggers: PullRequestTrigger[] }
  | { kind: "linked_issue"; trigger: LinkedIssueTrigger }
  | { kind: "merge_group"; trigger: MergeGroupTrigger }
  | { kind: "ignored"; reason: string };

const supportedActions = new Set<PullRequestAction>([
  "opened",
  "edited",
  "closed",
  "converted_to_draft",
  "reopened",
  "synchronize",
  "ready_for_review",
  "labeled",
  "unlabeled",
]);

const supportedReviewActions = new Set(["submitted", "edited", "dismissed"]);

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function isGitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value);
}

function associatedPullRequestNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const numbers: number[] = [];
  const seen = new Set<number>();
  for (const association of value) {
    if (!association || typeof association !== "object") {
      continue;
    }
    const number = positiveInteger((association as { number?: unknown }).number);
    if (number && !seen.has(number)) {
      seen.add(number);
      numbers.push(number);
    }
  }
  return numbers;
}

/**
 * Parses only the minimum trigger fields. Current base/head/merge state is
 * always loaded from GitHub again by the controller before verification.
 */
export function parsePullRequestWebhook(
  deliveryId: string,
  eventName: string | undefined,
  payload: unknown,
): ParsedWebhookEvent {
  const parsed = parseGitHubWebhook(deliveryId, eventName, payload);
  if (parsed.kind === "pull_request") {
    return { kind: "trigger", trigger: parsed.trigger };
  }
  return parsed.kind === "ignored"
    ? parsed
    : { kind: "ignored", reason: "Unsupported webhook event." };
}

/**
 * Parses only authenticated trigger coordinates. PR state is reloaded before
 * enqueue; a merge_group SHA is verified as a separate queue-generated target.
 */
export function parseGitHubWebhook(
  deliveryId: string,
  eventName: string | undefined,
  payload: unknown,
  options: GitHubWebhookParseOptions = {},
): ParsedGitHubWebhookEvent {
  if (!payload || typeof payload !== "object") {
    return { kind: "ignored", reason: "Webhook body is not an object." };
  }
  const body = payload as {
    action?: unknown;
    number?: unknown;
    installation?: { id?: unknown };
    repository?: { full_name?: unknown; id?: unknown };
    merge_group?: { base_sha?: unknown; head_sha?: unknown };
    pull_request?: { number?: unknown };
    issue?: { number?: unknown };
    check_run?: {
      status?: unknown;
      name?: unknown;
      app?: { id?: unknown };
      pull_requests?: unknown;
    };
  };
  const installationId = positiveInteger(body.installation?.id);
  const repositoryId = positiveInteger(body.repository?.id);
  const repository = body.repository?.full_name;

  if (eventName === "issues") {
    const issueNumber = positiveInteger(body.issue?.number);
    if (
      body.action !== "edited" ||
      !installationId ||
      !repositoryId ||
      !issueNumber ||
      typeof repository !== "string" ||
      repository.length === 0
    ) {
      return { kind: "ignored", reason: "Webhook lacks a valid linked-issue edit trigger." };
    }
    return {
      kind: "linked_issue",
      trigger: { deliveryId, installationId, repository, repositoryId, issueNumber },
    };
  }

  if (eventName === "check_run") {
    const checkName = body.check_run?.name;
    const checkAppId = positiveInteger(body.check_run?.app?.id);
    const pullRequests = associatedPullRequestNumbers(body.check_run?.pull_requests);
    if (
      body.action !== "completed" ||
      body.check_run?.status !== "completed" ||
      !installationId ||
      !repositoryId ||
      typeof repository !== "string" ||
      repository.length === 0 ||
      pullRequests.length === 0
    ) {
      return { kind: "ignored", reason: "Webhook lacks a completed PR-associated check run." };
    }
    const policy = options.checkRunPolicy;
    if (policy) {
      if (
        (policy.ownAppId !== undefined && checkAppId === policy.ownAppId) ||
        (policy.ownCheckName !== undefined && checkName === policy.ownCheckName)
      ) {
        return { kind: "ignored", reason: "MergeProof's own Check Run does not trigger verification." };
      }
      if (typeof checkName !== "string" || !policy.requiredChecks.includes(checkName)) {
        return { kind: "ignored", reason: "Completed Check Run is not a configured merge requirement." };
      }
      const expectedAppId = policy.requiredCheckAppIds?.[checkName];
      if (expectedAppId !== undefined && checkAppId !== expectedAppId) {
        return { kind: "ignored", reason: "Completed Check Run source does not match the configured GitHub App." };
      }
    }
    return {
      kind: "pull_requests",
      triggers: pullRequests.map((pullRequest) => ({
        deliveryId,
        action: "check_completed",
        installationId,
        repository,
        repositoryId,
        pullRequest,
      })),
    };
  }

  if (eventName === "pull_request_review") {
    const pullRequest = positiveInteger(body.number) ?? positiveInteger(body.pull_request?.number);
    if (
      typeof body.action !== "string" ||
      !supportedReviewActions.has(body.action) ||
      !installationId ||
      !repositoryId ||
      !pullRequest ||
      typeof repository !== "string"
    ) {
      return { kind: "ignored", reason: "Webhook lacks a valid pull-request review trigger." };
    }
    return {
      kind: "pull_request",
      trigger: {
        deliveryId,
        action: `review_${body.action}` as PullRequestAction,
        installationId,
        repository,
        repositoryId,
        pullRequest,
      },
    };
  }
  if (eventName !== "pull_request") {
    if (eventName !== "merge_group") {
      return { kind: "ignored", reason: "Unsupported webhook event." };
    }
    if (body.action !== "checks_requested") {
      return { kind: "ignored", reason: "Unsupported merge-group action." };
    }
    if (
      !installationId ||
      !repositoryId ||
      typeof repository !== "string" ||
      !isGitSha(body.merge_group?.base_sha) ||
      !isGitSha(body.merge_group?.head_sha)
    ) {
      return { kind: "ignored", reason: "Webhook lacks valid merge-group revision coordinates." };
    }
    return {
      kind: "merge_group",
      trigger: {
        deliveryId,
        installationId,
        repository,
        repositoryId,
        baseSha: body.merge_group.base_sha,
        headSha: body.merge_group.head_sha,
      },
    };
  }
  if (typeof body.action !== "string" || !supportedActions.has(body.action as PullRequestAction)) {
    return { kind: "ignored", reason: "Unsupported pull-request action." };
  }
  const pullRequest = positiveInteger(body.number);
  if (!installationId || !repositoryId || !pullRequest || typeof repository !== "string") {
    return { kind: "ignored", reason: "Webhook lacks a valid installation, repository, or PR id." };
  }
  return {
    kind: "pull_request",
    trigger: {
      deliveryId,
      action: body.action as PullRequestAction,
      installationId,
      repository,
      repositoryId,
      pullRequest,
    },
  };
}
