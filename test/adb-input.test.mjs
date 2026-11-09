import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { AdbStreamInput } from "../src/adb-input.mjs";

function fakeProc() {
  const proc = new EventEmitter();
  proc.exitCode = null;
  proc.killed = [];
  proc.stdin = {
    lines: [],
    write(line, cb) {
      this.lines.push(line);
      process.nextTick(() => cb?.());
    },
    on() {
      return this;
    },
  };
  proc.stderr = { on() {} };
  proc.kill = (sig) => {
    proc.killed.push(sig);
    proc.exitCode = 0;
    process.nextTick(() => proc.emit("exit"));
  };
  return proc;
}

test("AdbStreamInput queues commands in order on one shell", async () => {
  const procs = [];
  const input = new AdbStreamInput("ser", { width: 100, height: 200 }, () => {
    const p = fakeProc();
    procs.push(p);
    return p;
  });
  input.shell(["input", "keyevent", "3"]);
  input.shell(["input", "keyevent", "4"]);
  await input.queue;
  assert.equal(procs.length, 1);
  assert.deepEqual(procs[0].stdin.lines, ["input keyevent 3\n", "input keyevent 4\n"]);
  input.close();
});

test("close is permanent: queued commands do not respawn the shell", async () => {
  const procs = [];
  const input = new AdbStreamInput("ser", { width: 100, height: 200 }, () => {
    const p = fakeProc();
    procs.push(p);
    return p;
  });
  input.shell(["input", "keyevent", "3"]); // queued, not yet executed
  input.close();
  assert.equal(procs.length, 1);
  assert.equal(procs[0].killed.length, 1); // SIGTERM
  await input.queue;
  assert.equal(procs.length, 1); // no respawn
  assert.deepEqual(procs[0].stdin.lines, []); // nothing written after close
});

test("close is idempotent and clears pending coalesced state", async () => {
  const procs = [];
  const input = new AdbStreamInput("ser", { width: 100, height: 200 }, () => {
    const p = fakeProc();
    procs.push(p);
    return p;
  });
  input.touch("move", { x: 0.1, y: 0.2 }); // coalesced move pending
  input.scroll(0.1, { x: 0.5, y: 0.5 });
  assert.equal(input.move != null, true);
  assert.equal(input.wheel != null, true);
  input.close();
  input.close(); // second close no-op
  assert.equal(procs.length, 1);
  assert.equal(procs[0].killed.length, 1);
  assert.equal(input.move, null);
  assert.equal(input.wheel, null);
  assert.equal(input.held.size, 0);
  await input.queue;
  assert.equal(procs.length, 1); // still no respawn
});

test("commands queued before close that already ran do not error", async () => {
  const procs = [];
  const input = new AdbStreamInput("ser", { width: 100, height: 200 }, () => {
    const p = fakeProc();
    procs.push(p);
    return p;
  });
  input.shell(["input", "keyevent", "3"]);
  await input.queue; // executed on live shell
  assert.equal(procs[0].stdin.lines.length, 1);
  input.close();
  await input.queue; // pending chain after close resolves quietly
  assert.equal(procs.length, 1);
});
