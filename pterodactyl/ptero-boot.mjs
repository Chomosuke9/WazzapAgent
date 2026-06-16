// ---------------------------------------------------------------------------
// ptero-boot.mjs — entrypoint for a FIXED node-only Pterodactyl image.
//
// The parkervcp generic egg runs the server as `/usr/local/bin/${CMD_RUN}`,
// and `node` is the only interpreter guaranteed to live in /usr/local/bin on
// the yolks node-only images. So we set CMD_RUN="node pterodactyl/ptero-boot.mjs"
// and this launcher just hands off to the bash bootstrap (which provisions a
// portable Python + static ffmpeg into the volume, then runs the Node gateway
// and the Python bridge together).
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
