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
 * 2. the Desktop shell's confirmed-language cache, the one-line
 *    `locale-cache` file next to the Electron app's own settings. The shell
 *    rewrites it whenever the GUI confirms a language, including the
 *    automatic choice that follows the OS language before the user ever
 *    picks one explicitly.
 *
 * A `zh*` value selects the Chinese card; every other language selects the
 * English one. When neither source answers — for example a web profile served
 * to a browser whose language never reaches the Host — the card stays
 * bilingual, showing both sentences: no guess is made.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/** The Electron app's userData directory name on every platform. */
const DESKTOP_APP_SEGMENTS = ["@deepseek-ai", "dsh-desktop"];

/**
 * Candidate paths of the Desktop shell's confirmed-language cache.
 *
 * Best-effort by design: the file belongs to the Electron shell, not to this
 * plugin, so every candidate is optional and a missing file is expected.
 *
 * @param {string} [home] - the user's home directory.
 * @param {NodeJS.Platform} [platform]
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function desktopLocaleCachePaths(
  home = homedir(),
  platform = process.platform,
  env = process.env,
) {
  const roots = [];
  if (platform === "win32") {
    if (typeof env.APPDATA === "string" && env.APPDATA !== "") {
      roots.push(join(env.APPDATA, ...DESKTOP_APP_SEGMENTS));
    }
    roots.push(join(home, "AppData", "Roaming", ...DESKTOP_APP_SEGMENTS));
  } else if (platform === "darwin") {
    roots.push(join(home, "Library", "Application Support", ...DESKTOP_APP_SEGMENTS));
  } else {
    if (typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME !== "") {
      roots.push(join(env.XDG_CONFIG_HOME, ...DESKTOP_APP_SEGMENTS));
    }
    roots.push(join(home, ".config", ...DESKTOP_APP_SEGMENTS));
  }
  return roots.map((root) => join(root, "desktop", "locale-cache"));
}

/**
 * Read the Desktop shell's last confirmed language, best-effort.
 *
 * @returns {"zh" | "en" | undefined}
 */
export function readDesktopLocaleCache() {
  for (const path of desktopLocaleCachePaths()) {
    try {
      const language = cardLanguageOf(readFileSync(path, "utf8"));
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
