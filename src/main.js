/**
 * The engine's one entry point, compiled into the app as a single binary:
 *
 *   agent-pigeon-engine serve     run the engine (the Mac app starts this as its child)
 *   agent-pigeon-engine ht …      the control CLI (agent skills call this)
 *   agent-pigeon-engine version
 *
 * In a checkout the same commands run as `node src/main.js …`.
 */
import { log } from "./core/log.js";
import { runHt } from "./cli/ht.js";
import { VERSION } from "./core/version.js";

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "serve") {
  const { serve } = await import("./engine.js");
  await serve().catch((err) => {
    log("引擎启动失败", err);
    process.exit(1);
  });
} else if (cmd === "version" || cmd === "--version") {
  console.log(VERSION);
} else {
  process.exitCode = await runHt(cmd === "ht" ? rest : process.argv.slice(2));
}
