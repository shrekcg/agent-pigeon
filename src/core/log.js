/**
 * One append-only log file plus stdout. Rotates once at startup when the file passes 5 MB,
 * so a long-running relay never fills the disk with one growing file.
 */
import fs from "node:fs";
import { paths } from "./paths.js";

const MAX_BYTES = 5 * 1024 * 1024;
let ready = false;

function ensure() {
  if (ready) return;
  fs.mkdirSync(paths.logs, { recursive: true });
  try {
    const st = fs.statSync(paths.logFile);
    if (st.size > MAX_BYTES) fs.renameSync(paths.logFile, `${paths.logFile}.1`);
  } catch {
    /* no file yet */
  }
  ready = true;
}

function render(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function log(...args) {
  ensure();
  const line = `[${new Date().toISOString()}] ${args.map(render).join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(paths.logFile, `${line}\n`);
  } catch {
    /* logging must never take the relay down */
  }
}
