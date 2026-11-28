import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  cardLanguageOf,
  desktopLocaleCachePaths,
  localePreference,
  resolveCardLanguage,
} from "../lib/card-language.js";

test("cardLanguageOf maps a locale id onto the card language", () => {
  assert.equal(cardLanguageOf("zh"), "zh");
  assert.equal(cardLanguageOf("zh-CN"), "zh");
  assert.equal(cardLanguageOf("ZH-tw"), "zh");
  assert.equal(cardLanguageOf("en"), "en");
  assert.equal(cardLanguageOf("en-US"), "en");
  assert.equal(cardLanguageOf("ja"), "en");
  assert.equal(cardLanguageOf("pt"), "en");
  // Nothing said: no guess, the card stays bilingual.
  assert.equal(cardLanguageOf(undefined), undefined);
  assert.equal(cardLanguageOf(""), undefined);
  assert.equal(cardLanguageOf("  "), undefined);
  assert.equal(cardLanguageOf(null), undefined);
  // Anything else is "another language": English, per the requested rule.
  assert.equal(cardLanguageOf(42), "en");
});

test("localePreference reads the locale settings namespace", () => {
  const descriptors = [
    { ns: "llm-pi-ai", value: { providers: {} } },
    { ns: "locale", value: { preference: "zh" } },
  ];
  assert.equal(localePreference(descriptors), "zh");
  // The effective value is what counts, whatever layer it came from.
  assert.equal(localePreference([{ ns: "locale", value: { preference: "en-US" } }]), "en-US");
  // Unset, absent, or malformed: no preference.
  assert.equal(localePreference([{ ns: "locale", value: {} }]), undefined);
  assert.equal(localePreference([{ ns: "locale", value: { preference: "" } }]), undefined);
  assert.equal(localePreference([{ ns: "locale", value: undefined }]), undefined);
  assert.equal(localePreference([{ ns: "other", value: { preference: "zh" } }]), undefined);
  assert.equal(localePreference([]), undefined);
  assert.equal(localePreference(undefined), undefined);
});

function settingsWith(descriptors) {
  return { describe: () => descriptors };
}

test("resolveCardLanguage prefers the explicit preference, then the shell cache", () => {
  const zh = settingsWith([{ ns: "locale", value: { preference: "zh" } }]);
  const unset = settingsWith([{ ns: "locale", value: {} }]);
  assert.equal(resolveCardLanguage(zh, () => "en"), "zh", "the setting wins over the cache");
  assert.equal(resolveCardLanguage(unset, () => "en"), "en", "unset falls back to the cache");
  assert.equal(resolveCardLanguage(unset, () => undefined), undefined, "no answer stays bilingual");
  assert.equal(resolveCardLanguage(undefined, () => "zh"), "zh", "no settings service: cache only");
  assert.equal(
    resolveCardLanguage({ describe: () => { throw new Error("boom"); } }, () => "en"),
    "en",
    "a settings layer that cannot be described is skipped",
  );
  // The real cache read is best-effort: it may answer or not, never throw.
  const read = resolveCardLanguage(undefined);
  assert.ok(read === undefined || read === "zh" || read === "en");
});

test("desktopLocaleCachePaths names the shell's confirmed-language file per platform", () => {
  const windows = desktopLocaleCachePaths("C:\\Users\\u", "win32", {
    APPDATA: "C:\\Users\\u\\AppData\\Roaming",
  });
  assert.deepEqual(windows, [
    join("C:\\Users\\u\\AppData\\Roaming", "@deepseek-ai", "dsh-desktop", "desktop", "locale-cache"),
    join("C:\\Users\\u", "AppData", "Roaming", "@deepseek-ai", "dsh-desktop", "desktop", "locale-cache"),
  ]);
  // APPDATA missing: the home-relative candidate remains.
  assert.equal(desktopLocaleCachePaths("/home/u", "win32", {}).length, 1);

  const mac = desktopLocaleCachePaths("/Users/u", "darwin", {});
  assert.deepEqual(mac, [
    join("/Users/u", "Library", "Application Support", "@deepseek-ai", "dsh-desktop", "desktop", "locale-cache"),
  ]);

  const linux = desktopLocaleCachePaths("/home/u", "linux", {
    XDG_CONFIG_HOME: "/home/u/.config",
  });
  assert.deepEqual(linux, [
    join("/home/u/.config", "@deepseek-ai", "dsh-desktop", "desktop", "locale-cache"),
    join("/home/u", ".config", "@deepseek-ai", "dsh-desktop", "desktop", "locale-cache"),
  ]);
});
