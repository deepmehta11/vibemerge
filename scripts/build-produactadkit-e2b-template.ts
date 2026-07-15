import { Template } from "e2b";

if (!process.env.E2B_API_KEY) {
  throw new Error("E2B_API_KEY is required to build the Product AdKit verification template.");
}

/**
 * This image is deliberately test-only: production AI providers, model
 * weights, and credentials stay out.  The controller uploads candidate
 * source plus a frozen regression corpus at verification time.
 */
const template = Template({ fileContextPath: process.cwd() })
  .fromPythonImage("3.12")
  // The controller-owned harness is Node-based even though this repository's
  // candidate source and frozen regression corpus are Python.
  .aptInstall(["nodejs", "npm", "time"])
  .copy("harness/templates/produactadkit-engine.requirements.lock", "/tmp/requirements.lock")
  .runCmd([
    "python -m pip install --no-cache-dir --upgrade pip",
    "python -m pip install --no-cache-dir -r /tmp/requirements.lock",
    "python -m playwright install --with-deps chromium",
    "node --version",
    "python -c \"import fastapi, httpx, numpy, PIL, playwright, pytest; print('product-adkit-template-ready')\"",
  ]);

const build = await Template.build(template, "vibemerge-produactadkit-engine", {
  cpuCount: 2,
  memoryMB: 4096,
});

// Production must use this immutable selector, never the mutable template name.
console.info(JSON.stringify({
  event: "e2b_template_ready",
  template: `${build.name}:${build.buildId}`,
  templateId: build.templateId,
  buildId: build.buildId,
}));
