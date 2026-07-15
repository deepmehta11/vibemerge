import { GitHubAppInstallationTokenProvider } from "./github-app.js";
import { sourcePinnedRequiredChecks, verifyGitHubActivation } from "./github-activation.js";
import { GitHubRestGateway } from "./github-gateway.js";
import { loadControllerPolicy } from "./runtime.js";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

const env = process.env;
const appId = positiveInteger(required(env, "GITHUB_APP_ID"), "GITHUB_APP_ID");
// The activation check intentionally reads the same maintainer-owned policy as
// the service. Queue activation needs only required CI names and source App ids;
// it does not instantiate the runtime, open a port, or make any GitHub write.
const policy = loadControllerPolicy(required(env, "MERGEPROOF_POLICY_PATH"));
const result = await verifyGitHubActivation(
  {
    installationId: positiveInteger(
      required(env, "MERGEPROOF_ACTIVATION_INSTALLATION_ID"),
      "MERGEPROOF_ACTIVATION_INSTALLATION_ID",
    ),
    repository: required(env, "MERGEPROOF_ACTIVATION_REPOSITORY"),
    branch: required(env, "MERGEPROOF_ACTIVATION_BRANCH"),
    requiredChecks: sourcePinnedRequiredChecks(policy.merge),
    requiredEvidenceCheck: { name: "MergeProof / evidence", appId },
  },
  new GitHubAppInstallationTokenProvider(
    String(appId),
    required(env, "GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
  ),
  { create: (token) => new GitHubRestGateway(token) },
);

// This is intentionally safe metadata only: no token, webhook body, PR
// content, model output, or sandbox data is present in activation output.
console.info(JSON.stringify({ service: "mergeproof", event: "github_activation_verified", ...result }));
