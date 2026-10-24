/**
 * The SDK's major (contracts versioning.md §3.2). It must equal the major of
 * package.json's version; tests check that.
 */
export const SDK_MAJOR = 1;

const warnedSources = new Set<string>();

/**
 * Warn once per process per kind of peer when a device or hapbeat-helper
 * reports a newer major than this SDK (versioning.md §3.3).
 */
export function warnIfNewerGeneration(peer: "device" | "hapbeat-helper", generation: number | undefined, where: string): void {
  if (generation === undefined || generation <= SDK_MAJOR || warnedSources.has(peer)) return;
  warnedSources.add(peer);
  console.warn(
    `[hapbeat] ${where} reports generation ${generation}, newer than this SDK (${SDK_MAJOR}.x). ` +
    "Update @hapbeat/sdk to use all of its features.",
  );
}
