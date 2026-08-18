// ---------------------------------------------------------------------------
// ptero-boot.mjs — entrypoint for a FIXED node-only Pterodactyl image.
//
// The public generic Node egg needs an administrator-level startup override
// whose final command invokes this file with /usr/local/bin/node.
// Some custom eggs expose the equivalent as CMD_RUN. This launcher then hands
// off to the bash bootstrap, which provisions portable Python and optional
// media tools before running the Node gateway and Python bridge together.
//
// We exec bash directly via its absolute path (/bin/bash) so we don't depend on
// bash being in /usr/local/bin. Signals are forwarded so Pterodactyl's Stop
// (SIGINT/SIGTERM) tears the whole tree down cleanly.
// ---------------------------------------------------------------------------
import { spawn } from "node:child_process";

const child = spawn("/bin/bash", ["pterodactyl/ptero-bootstrap.sh"], {
  stdio: "inherit",
  env: process.env,
});

const forward = (signal) => {
  try {
    child.kill(signal);
  } catch {
    /* child already gone */
  }
};
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));

child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
child.on("error", (err) => {
  console.error("[ptero-boot] failed to start bootstrap:", err);
  process.exit(1);
});
