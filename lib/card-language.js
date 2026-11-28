/**
 * Which single language the review-choice card speaks.
 *
 * The card text is built on the Host, which has no viewer locale of its own,
 * so the language the GUI actually shows has to come from a Host-readable
 * place. There are two:
 *
 * 1. `locale.preference` — the Language row in Settings → General. The client
 *    persists it through the Host settings service in the `locale` namespace
 *    (`dsh-client-locale`), so it is readable with `settings.describe()`.
 * 2. the Desktop shell's remembered language, the per-profile JSON map
 *    `desktop-locale.json` in the DSH home directory (the `<home>/desktop-locale.json`
 *    file the Desktop main process rewrites whenever the GUI confirms a
 *    language, including the automatic choice that follows the OS language
 *    before the user ever picks one explicitly). The Host cannot ask the
 *    Desktop main process for its home, so the file is looked up under every
 *    plausible DSH home, best-effort.
 *
 * A `zh*` value selects the Chinese card; every other language selects the
 * English one. When neither source answers — for example a web profile served
 * to a browser whose language never reaches the Host — the card stays
 * bilingual, showing both sentences: no guess is made.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";

/** Settings namespace `dsh-client-locale` registers and writes. */
export const LOCALE_SETTINGS_NAMESPACE = "locale";

/** Field of that namespace holding the explicit preference. */
export const LOCALE_PREFERENCE_FIELD = "preference";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The explicit locale preference from `settings.describe()` output, when the
 * namespace is mounted and the preference is set.
 *
 * @param {readonly object[]} descriptors - result of `settings.describe()`.
 * @returns {string | undefined}
 */
export function localePreference(descriptors) {
  if (!Array.isArray(descriptors)) return undefined;
  const descriptor = descriptors.find(
    (item) => isPlainObject(item) && item.ns === LOCALE_SETTINGS_NAMESPACE,
  );
  const value = descriptor?.value;
  const preference = isPlainObject(value) ? value[LOCALE_PREFERENCE_FIELD] : undefined;
  return typeof preference === "string" && preference.trim() !== "" ? preference : undefined;
}

/** The primary subtag of a BCP 47-style id, lowercased (`zh-CN` → `zh`). */
function primarySubtag(id) {
  return String(id ?? "")
    .split("-")[0]
    .trim()
    .toLowerCase();
}

/**
 * The card language one locale id selects.
 *
 * @param {unknown} id - a preference or cached shell language.
 * @returns {"zh" | "en" | undefined} `zh` for a `zh*` id, `en` for every other
 *   language (the card has no other-language copy), `undefined` when the id
 *   says nothing.
 */
export function cardLanguageOf(id) {
  const primary = primarySubtag(id);
  if (primary === "") return undefined;
  return primary === "zh" ? "zh" : "en";
}

/** The Desktop shell's remembered-language file, relative to a DSH home. */
const DESKTOP_LOCALE_FILE = "desktop-locale.json";

/** The Desktop data-directory pointer files, relative to their roots. */
const LAST_HOME_FILE = join("home", "desktop-next-last-home.json");
const LOCATION_FILE = join("home", "desktop-next-location.json");

/**
 * The DSH home directory, when the Host process knows it.
 *
 * Desktop launches its terminal children with `DSH_HOME` in the
 * environment; a CLI-launched Host has the same variable through
 * `resolveDshHome()`. Only a variable that actually holds a non-empty
 * string counts.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | undefined}
 */
function envHome(env) {
  const value = typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  // normalize() folds separators, so the same directory spelled with forward
  // or back slashes collapses into one candidate. An absolute DSH_HOME is
  // kept absolute — join() would wrongly treat a rooted path as relative.
  return value !== "" ? normalize(value) : undefined;
}

/**
 * One home path recorded in a Desktop pointer file, when readable.
 *
 * The packaged Desktop keeps its chosen data directory in
 * `%APPDATA%/DSH Desktop Beta/home/desktop-next-(last-home|location).json`
 * (development builds use `<install>/.desktop-next/home`); the file is a
 * one-line `{"home": "…"}` JSON. A missing, unreadable or malformed file
 * is simply skipped.
 *
 * @param {string} pointerRoot
 * @returns {string | undefined}
 */
function readPointerHome(pointerRoot) {
  for (const name of [LAST_HOME_FILE, LOCATION_FILE]) {
    try {
      const parsed = JSON.parse(readFileSync(join(pointerRoot, name), "utf8"));
      const home = parsed?.home;
      if (typeof home === "string" && home.trim() !== "") return home.trim();
    } catch {
      // No pointer file there: the next candidate root speaks instead.
    }
  }
  return undefined;
}

/**
 * Roots that may hold a Desktop data-directory pointer file.
 *
 * @param {string} home - the user's home directory.
 * @param {NodeJS.Platform} [platform]
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
function pointerRoots(home, platform, env) {
  const roots = [];
  const appData =
    platform === "win32" && typeof env.APPDATA === "string" && env.APPDATA !== ""
      ? env.APPDATA
      : platform === "win32"
        ? join(home, "AppData", "Roaming")
        : platform === "darwin"
          ? join(home, "Library", "Application Support")
          : typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME !== ""
            ? env.XDG_CONFIG_HOME
            : join(home, ".config");
  roots.push(join(appData, "DSH Desktop Beta"));
  // Development builds: the pointer root sits in the install tree.
  roots.push(".desktop-next");
  return roots;
}

/**
 * Candidate DSH home directories to look for `desktop-locale.json` under.
 *
 * Best-effort by design: the home belongs to the Desktop shell and the
 * launcher, not to this plugin, so every candidate is optional and a
 * missing directory is expected.
 *
 * @param {string} [home] - the user's home directory.
 * @param {NodeJS.Platform} [platform]
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function dshHomeCandidates(home = homedir(), platform = process.platform, env = process.env) {
  const candidates = [];
  const fromEnv = envHome(env);
  if (fromEnv !== undefined) candidates.push(fromEnv);
  for (const root of pointerRoots(home, platform, env)) {
    const pointed = readPointerHome(root);
    if (pointed !== undefined) candidates.push(pointed);
  }
  candidates.push(join(home, ".dsh-beta"));
  candidates.push(join(home, ".dsh"));
  return [...new Set(candidates)];
}

/**
 * Candidate paths of the Desktop shell's remembered-language file.
 *
 * @param {string} [home] - the user's home directory.
 * @param {NodeJS.Platform} [platform]
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function desktopLocaleCachePaths(home = homedir(), platform = process.platform, env = process.env) {
  return dshHomeCandidates(home, platform, env).map((root) => join(root, DESKTOP_LOCALE_FILE));
}

/**
 * The card language one remembered-language entry selects. The map stores
 * one entry per Desktop profile; the Host cannot know which profile the
 * current GUI session runs, so the first entry that names a language wins
 * (the `desktop` profile is preferred, then any other).
 *
 * @param {string} raw - the `desktop-locale.json` file contents.
 * @returns {"zh" | "en" | undefined}
 */
export function cardLanguageOfLocaleMap(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  const preferredKey = Object.keys(parsed).find((key) => key === "desktop");
  const keys = preferredKey !== undefined ? [preferredKey, ...Object.keys(parsed)] : Object.keys(parsed);
  for (const key of keys) {
    const language = cardLanguageOf(parsed[key]);
    if (language !== undefined) return language;
  }
  return undefined;
}

/**
 * Read the Desktop shell's last confirmed language, best-effort.
 *
 * @returns {"zh" | "en" | undefined}
 */
export function readDesktopLocaleCache() {
  for (const path of desktopLocaleCachePaths()) {
    try {
      const language = cardLanguageOfLocaleMap(readFileSync(path, "utf8"));
      if (language !== undefined) return language;
    } catch {
      // Missing or unreadable: try the next candidate, then stay bilingual.
    }
  }
  return undefined;
}

/**
 * Resolve the card language for one ask: the explicit preference first, the
 * Desktop cache as the automatic-mode fallback.
 *
 * @param {{ describe?: (...args: unknown[]) => object[] } | undefined} settings
 * @param {() => "zh" | "en" | undefined} [readCache]
 * @returns {"zh" | "en" | undefined}
 */
export function resolveCardLanguage(settings, readCache = readDesktopLocaleCache) {
  if (settings !== undefined && typeof settings.describe === "function") {
    try {
      const language = cardLanguageOf(localePreference(settings.describe()));
      if (language !== undefined) return language;
    } catch {
      // A settings layer that cannot be described is simply not consulted.
    }
  }
  return readCache();
}
