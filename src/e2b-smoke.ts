import { Sandbox } from "e2b";

if (!process.env.E2B_API_KEY) {
  throw new Error("Set E2B_API_KEY in the runtime environment before running this smoke test.");
}

let sandbox: Sandbox | undefined;
try {
  sandbox = await Sandbox.create({
    timeoutMs: 60_000,
    allowInternetAccess: false,
    network: { allowPublicTraffic: false },
    metadata: { mergeproofPurpose: "smoke-test" },
  });
  const result = await sandbox.commands.run("printf mergeproof-e2b-smoke");
  if (result.exitCode !== 0 || result.stdout !== "mergeproof-e2b-smoke") {
    throw new Error(`Unexpected E2B smoke output (exit ${result.exitCode}).`);
  }
  console.log(`E2B smoke test passed (sandbox ${sandbox.sandboxId}).`);
} finally {
  await sandbox?.kill().catch(() => undefined);
}
