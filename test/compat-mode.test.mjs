import assert from "node:assert/strict";
import test from "node:test";
import {
  findProviderEntry,
  planCompatOps,
  syncCompat,
} from "../lib/compat-mode.js";

const gateway = { api: "openai-completions", baseURL: "https://example.com/v1" };

function descriptor({ value, user = value, base = {}, ns = "llm-pi-ai", revision = 3 }) {
  return { ns, revision, value, user, base };
}

test("finds only the entry that declares the provider", () => {
  const other = descriptor({ ns: "ui-settings", value: { theme: "dark" } });
  const piAi = descriptor({ value: { providers: { gw: gateway } } });
  assert.equal(findProviderEntry([other, piAi], "gw"), piAi);
  assert.equal(findProviderEntry([other, piAi], "missing"), undefined);
  assert.equal(findProviderEntry([other, piAi], ""), undefined);
  assert.equal(findProviderEntry(undefined, "gw"), undefined);
});

test("enabled sets compat.supportsStore to false", () => {
  const entry = descriptor({ value: { providers: { gw: gateway } } });
  assert.deepEqual(planCompatOps(entry, "gw", true), [
    { op: "set", path: ["providers", "gw", "compat", "supportsStore"], value: false },
  ]);
});

test("enabled keeps other compat keys and overrides supportsStore: true", () => {
  const entry = descriptor({
    value: { providers: { gw: { ...gateway, compat: { supportsStore: true, maxTokensField: "max_tokens" } } } },
  });
  assert.deepEqual(planCompatOps(entry, "gw", true), [
    { op: "set", path: ["providers", "gw", "compat", "supportsStore"], value: false },
  ]);
});

test("enabled does nothing when the flag is already false", () => {
  const entry = descriptor({
    value: { providers: { gw: { ...gateway, compat: { supportsStore: false } } } },
  });
  assert.deepEqual(planCompatOps(entry, "gw", true), []);
});

test("disabled removes compat when supportsStore was its only key", () => {
  const entry = descriptor({
    value: { providers: { gw: { ...gateway, compat: { supportsStore: false } } } },
  });
  assert.deepEqual(planCompatOps(entry, "gw", false), [
    { op: "unset", path: ["providers", "gw", "compat"] },
  ]);
});

test("disabled removes only supportsStore when compat has other keys", () => {
  const entry = descriptor({
    value: { providers: { gw: { ...gateway, compat: { supportsStore: false, maxTokensField: "max_tokens" } } } },
  });
  assert.deepEqual(planCompatOps(entry, "gw", false), [
    { op: "unset", path: ["providers", "gw", "compat", "supportsStore"] },
  ]);
});

test("disabled leaves values from a lower configuration layer alone", () => {
  const value = { providers: { gw: { ...gateway, compat: { supportsStore: false } } } };
  const entry = descriptor({ value, user: {}, base: value });
  assert.deepEqual(planCompatOps(entry, "gw", false), []);
});

test("disabled does nothing when the flag is absent", () => {
  const entry = descriptor({ value: { providers: { gw: gateway } } });
  assert.deepEqual(planCompatOps(entry, "gw", false), []);
});

test("no entry or no provider plans nothing", () => {
  assert.deepEqual(planCompatOps(undefined, "gw", true), []);
  assert.deepEqual(planCompatOps(descriptor({ value: {} }), "", true), []);
});

test("syncCompat writes the planned ops with the descriptor revision", async () => {
  const calls = [];
  const settings = {
    describe: () => [descriptor({ value: { providers: { gw: gateway } }, revision: 7 })],
    mutate: async (...args) => {
      calls.push(args);
    },
  };
  const result = await syncCompat(settings, "gw", true);
  assert.equal(result.ns, "llm-pi-ai");
  assert.deepEqual(calls, [
    ["llm-pi-ai", [{ op: "set", path: ["providers", "gw", "compat", "supportsStore"], value: false }], 7],
  ]);
});

test("syncCompat skips mutate when nothing changes", async () => {
  let mutated = false;
  const settings = {
    describe: () => [],
    mutate: async () => {
      mutated = true;
    },
  };
  assert.deepEqual((await syncCompat(settings, "gw", true)).ops, []);
  assert.equal(mutated, false);
});
