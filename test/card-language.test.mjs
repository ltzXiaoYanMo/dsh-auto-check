import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  cardLanguageOf,
  cardLanguageOfLocaleMap,
  desktopLocaleCachePaths,
  dshHomeCandidates,
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

test("desktopLocaleCachePaths names the shell's remembered-language file per DSH home", () => {
  // No env home, no pointer files: the default homes, newest first.
  const plain = desktopLocaleCachePaths("/home/u", "linux", {});
  assert.deepEqual(plain, [
    join("/home/u", ".dsh-beta", "desktop-locale.json"),
    join("/home/u", ".dsh", "desktop-locale.json"),
  ]);

  // $DSH_HOME wins over everything else, normalized in place.
  const envHome = desktopLocaleCachePaths("/home/u", "linux", { DSH_HOME: "/opt/dsh" });
  assert.deepEqual(envHome, [
    join("/", "opt", "dsh", "desktop-locale.json"),
    join("/home/u", ".dsh-beta", "desktop-locale.json"),
    join("/home/u", ".dsh", "desktop-locale.json"),
  ]);
  // The same directory spelled with forward or back slashes is one candidate.
  const duplicate = desktopLocaleCachePaths("/home/u", "linux", {
    DSH_HOME: "/home/u/.dsh-beta",
  });
  assert.deepEqual(duplicate, [
    join("/home/u", ".dsh-beta", "desktop-locale.json"),
    join("/home/u", ".dsh", "desktop-locale.json"),
  ]);

  // No readable pointer file: the defaults still answer.
  const missing = dshHomeCandidates("/home/u", "win32", {
    APPDATA: "/tmp/appdata/missing",
  });
  assert.deepEqual(missing, [
    join("/home/u", ".dsh-beta"),
    join("/home/u", ".dsh"),
  ]);
});

test("dshHomeCandidates follows the Desktop data-directory pointer", () => {
  const root = mkdtempSync(join(tmpdir(), "card-language-"));
  const appData = root;
  const pointerRoot = join(root, "DSH Desktop Beta");
  mkdirSync(join(pointerRoot, "home"), { recursive: true });
  writeFileSync(
    join(pointerRoot, "home", "desktop-next-last-home.json"),
    JSON.stringify({ home: "C:\\Users\\real\\.dsh-beta" }),
  );
  const candidates = dshHomeCandidates("/home/u", "win32", {
    APPDATA: appData,
  });
  assert.deepEqual(candidates, [
    "C:\\Users\\real\\.dsh-beta",
    join("/home/u", ".dsh-beta"),
    join("/home/u", ".dsh"),
  ]);
});

test("cardLanguageOfLocaleMap reads the per-profile language map", () => {
  assert.equal(cardLanguageOfLocaleMap('{"desktop":"zh"}'), "zh");
  assert.equal(cardLanguageOfLocaleMap('{"web":"en"}'), "en");
  // The desktop profile is preferred when several profiles answered.
  assert.equal(cardLanguageOfLocaleMap('{"web":"en","desktop":"zh"}'), "zh");
  // The first answering entry wins otherwise.
  assert.equal(cardLanguageOfLocaleMap('{"acp":"zh","web":"en"}'), "zh");
  // Anything else is "another language": English, per the requested rule.
  assert.equal(cardLanguageOfLocaleMap('{"desktop":"ja"}'), "en");
  // Unreadable input names no language.
  assert.equal(cardLanguageOfLocaleMap("not json"), undefined);
  assert.equal(cardLanguageOfLocaleMap('[]'), undefined);
  assert.equal(cardLanguageOfLocaleMap('{}'), undefined);
  assert.equal(cardLanguageOfLocaleMap('{"desktop":42}'), "en");
});

test("readDesktopLocaleCache reads a real remembered-language file", () => {
  const root = mkdtempSync(join(tmpdir(), "card-language-"));
  const dshHome = join(root, "dsh-home");
  mkdirSync(dshHome, { recursive: true });
  writeFileSync(join(dshHome, "desktop-locale.json"), '{"desktop":"zh"}');
  // Injected through a pointer file so no env variable leaks between tests.
  const pointerRoot = join(root, "DSH Desktop Beta");
  mkdirSync(join(pointerRoot, "home"), { recursive: true });
  writeFileSync(
    join(pointerRoot, "home", "desktop-next-location.json"),
    JSON.stringify({ home: dshHome }),
  );
  const read = desktopLocaleCachePaths(join(root, "user"), "win32", {
    APPDATA: root,
  });
  assert.equal(read[0], join(dshHome, "desktop-locale.json"));
  const language = (() => {
    for (const path of read) {
      try {
        const found = cardLanguageOfLocaleMap(readFileSync(path, "utf8"));
        if (found !== undefined) return found;
      } catch {}
    }
  })();
  assert.equal(language, "zh");
});
