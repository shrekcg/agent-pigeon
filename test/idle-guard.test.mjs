/**
 * The run-edge guard: a stream connection opens with a `task_state` snapshot, so an `idle`
 * that no `running` preceded is not a run end. Getting this wrong reposts an old answer into
 * the topic after every reconnect — the regression this test pins down.
 *
 * Run with: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { idleEdge } from "../src/core/commands.js";

test("the connect snapshot is not a run end", () => {
  const entry = { runSeen: false };
  assert.equal(idleEdge(entry), "snapshot");
});

test("a fresh entry (no run seen yet) is a snapshot", () => {
  assert.equal(idleEdge({}), "snapshot");
});

test("a snapshot with stale text from an earlier run is still a snapshot", () => {
  const entry = { lastAssistantText: "上一轮的回答", runText: "上一轮的过程", runSeen: false };
  assert.equal(idleEdge(entry), "snapshot");
  assert.equal(entry.lastAssistantText, "上一轮的回答"); // classification does not touch content
});

test("running → idle is a run end, exactly once", () => {
  const entry = { runSeen: true };
  assert.equal(idleEdge(entry), "run-end");
  assert.equal(entry.runSeen, false);
  // A duplicate idle, or the snapshot of a reconnect right after, must not end a run again.
  assert.equal(idleEdge(entry), "snapshot");
});

test("every run gets its own edge", () => {
  const entry = { runSeen: false };
  assert.equal(idleEdge(entry), "snapshot");
  entry.runSeen = true;
  assert.equal(idleEdge(entry), "run-end");
  entry.runSeen = true;
  assert.equal(idleEdge(entry), "run-end");
});
