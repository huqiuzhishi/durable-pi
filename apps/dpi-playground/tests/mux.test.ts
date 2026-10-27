import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Request, Response } from "express";
import type { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import type { DeviceMonitor } from "../apps/dpi-playground-hub/src/monitor.js";
import { StreamMux } from "../apps/dpi-playground-hub/src/mux.js";

test("mux closes a slow browser stream before another write", () => {
  let changed = () => {};
  let unsubscribed = false;
  const monitor = {
    network: () => [],
    onChange: (listener: () => void) => {
      changed = listener;
      return () => (unsubscribed = true);
    },
  } as unknown as DeviceMonitor;
  const mux = new StreamMux({} as NetworkRegistry, monitor);
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    writes: [] as string[],
    status() {
      return this;
    },
    set() {
      return this;
    },
    flushHeaders() {},
    write(data: string) {
      assert.equal(this.writableEnded, false, "must not write after end");
      this.writes.push(data);
    },
    end() {
      this.writableEnded = true;
    },
  });

  mux.open({} as Request, res as unknown as Response);
  assert.equal(mux.size, 1);
  res.writableLength = 4_000_001;
  changed();

  assert.equal(res.writableEnded, true);
  assert.equal(unsubscribed, true);
  assert.equal(mux.size, 0);
  changed();
  assert.equal(res.writes.length, 2);
});
