import { createRuntime } from "./runtime.js";

// Validates every local file, policy invariant, and startup-only credential
// requirement without listening for webhooks or making a GitHub, OpenAI, or
// E2B network request. Run this in deployment before shifting traffic.
const runtime = createRuntime();
try {
  console.info(
    JSON.stringify({
      service: "mergeproof",
      event: "configuration_valid",
      port: runtime.port,
    }),
  );
} finally {
  runtime.setReady(false);
  runtime.close();
}
