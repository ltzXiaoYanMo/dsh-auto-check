/**
 * Compatibility mode: keep `compat.supportsStore: false` on the reviewer's
 * provider profile.
 *
 * pi-ai reads `compat` only from the provider/model configuration
 * (`getCompat(model)`), never from an individual request, and attaches
 * `store: false` whenever `supportsStore` is true. Some OpenAI-compatible
 * gateways reject that field, so the only working switch is the provider
 * profile itself. The profile lives in the `llm-pi-ai` entry's volatile
 * `providers` dict, which the settings service can edit.
 *
 * These helpers are pure: they read settings descriptors and return the
 * `settings.mutate` operations, so the service only performs I/O.
 */

/** Path of the flag inside one provider profile. */
export const SUPPORTS_STORE_PATH = ["compat", "supportsStore"];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read one provider profile from a settings layer.
 * @param {unknown} layer - a descriptor's `value`, `user` or `base`.
 * @param {string} provider
 * @returns {Record<string, unknown> | undefined}
 */
function profileOf(layer, provider) {
  if (!isPlainObject(layer) || !isPlainObject(layer.providers)) return undefined;
  if (!Object.hasOwn(layer.providers, provider)) return undefined;
  const profile = layer.providers[provider];
  return isPlainObject(profile) ? profile : undefined;
}

/**
 * Find the settings entry that declares the provider route.
 *
 * Only an entry that already has a profile for the provider is chosen, so a
 * route served by some other adapter is never given a stray profile.
 *
 * @param {readonly object[]} descriptors - result of `settings.describe()`.
 * @param {string} provider
 * @returns {object | undefined} the matching descriptor.
 */
export function findProviderEntry(descriptors, provider) {
  if (!Array.isArray(descriptors) || provider === "") return undefined;
  return descriptors.find(
    (descriptor) => profileOf(descriptor?.value, provider) !== undefined,
  );
}

/**
 * Plan the settings edits for one provider.
 *
 * Enabled: set `compat.supportsStore` to `false` unless the effective value
 * already is `false`.
 *
 * Disabled: remove `compat.supportsStore` from the profile override when it is
 * `false` there, and drop `compat` when nothing else is left in it. Values
 * from a lower configuration layer are left alone (settings cannot delete
 * them anyway).
 *
 * @param {object | undefined} descriptor - from {@link findProviderEntry}.
 * @param {string} provider
 * @param {boolean} enabled
 * @returns {{ op: "set" | "unset", path: string[], value?: unknown }[]}
 */
export function planCompatOps(descriptor, provider, enabled) {
  if (descriptor === undefined || provider === "") return [];
  const flagPath = ["providers", provider, ...SUPPORTS_STORE_PATH];

  if (enabled) {
    const compat = profileOf(descriptor.value, provider)?.compat;
    if (isPlainObject(compat) && compat.supportsStore === false) return [];
    return [{ op: "set", path: flagPath, value: false }];
  }

  const compat = profileOf(descriptor.user, provider)?.compat;
  if (!isPlainObject(compat) || compat.supportsStore !== false) return [];
  const others = Object.keys(compat).filter((key) => key !== "supportsStore");
  const baseCompat = profileOf(descriptor.base, provider)?.compat;
  if (others.length === 0 && baseCompat === undefined) {
    return [{ op: "unset", path: ["providers", provider, "compat"] }];
  }
  return [{ op: "unset", path: flagPath }];
}

/**
 * Bring one provider profile in line with the compatibility switch.
 *
 * @param {{ describe(): object[], mutate(ns: string, ops: object[], revision?: number): Promise<void> }} settings
 * @param {string} provider - reviewer provider route; empty does nothing.
 * @param {boolean} enabled
 * @returns {Promise<{ ns?: string, ops: object[] }>} what was written.
 */
export async function syncCompat(settings, provider, enabled) {
  const descriptor = findProviderEntry(settings.describe(), provider);
  const ops = planCompatOps(descriptor, provider, enabled);
  if (ops.length === 0) return { ns: descriptor?.ns, ops };
  await settings.mutate(descriptor.ns, ops, descriptor.revision);
  return { ns: descriptor.ns, ops };
}
