/**
 * EventMap — the tuning side of the SDK, kept orthogonal to the fire side.
 *
 * Mirrors the Unity SDK's EventMap at level-1: a catalog mapping an event id
 * to its clip gain (and per-event metadata), linked to firing only by id.
 *
 * The canonical source of per-event clip gain is the kit manifest
 * (`parameters.clip_gain`, schema 2.0.0, hapbeat-contracts/specs/kit-format.md).
 * `clipGain` is the material's strength (0..1, WAV × clip_gain); the facade
 * multiplies it by the call's `gain` (app gain) and sends
 * `clamp(clipGain × gain, 0, 1)`, so `hb.play("id")` fires at authored strength.
 */

export interface EventDef {
  eventId: string;
  /** Material strength from the manifest `parameters.clip_gain` (0..1, default 1). */
  clipGain: number;
  loop: boolean;
  deviceWiper?: number;
  streaming: boolean; // came from the manifest stream_events bucket → clip mode
  /** Clip-mode (streaming) only: WAV filename, resolved against `clipBase`. */
  clip?: string;
  note: string;
}

interface ManifestEntry {
  clip?: string;
  note?: string;
  parameters?: { clip_gain?: number; loop?: boolean; device_wiper?: number };
}

export interface KitManifest {
  schema_version?: string;
  events?: Record<string, ManifestEntry>;
  stream_events?: Record<string, ManifestEntry>;
}

export class EventMap {
  private readonly events: Map<string, EventDef>;

  constructor(events?: Record<string, EventDef> | Map<string, EventDef>) {
    this.events = events instanceof Map ? new Map(events) : new Map(Object.entries(events ?? {}));
  }

  /** Build from a simple `{ eventId: clipGain }` mapping (no kit manifest). */
  static fromClipGains(clipGains: Record<string, number>): EventMap {
    const m = new Map<string, EventDef>();
    for (const [eventId, clipGain] of Object.entries(clipGains)) {
      m.set(eventId, { eventId, clipGain, loop: false, streaming: false, note: "" });
    }
    return new EventMap(m);
  }

  /** Build from a parsed kit manifest (schema 2.0.0). */
  static fromManifest(manifest: KitManifest): EventMap {
    const m = new Map<string, EventDef>();
    const buckets: Array<[Record<string, ManifestEntry> | undefined, boolean]> = [
      [manifest.events, false],
      [manifest.stream_events, true],
    ];
    for (const [bucket, streaming] of buckets) {
      for (const [eventId, entry] of Object.entries(bucket ?? {})) {
        const p = entry?.parameters ?? {};
        m.set(eventId, {
          eventId,
          clipGain: p.clip_gain ?? 1.0,
          loop: p.loop ?? false,
          deviceWiper: p.device_wiper,
          streaming,
          clip: streaming ? entry?.clip : undefined,
          note: entry?.note ?? "",
        });
      }
    }
    return new EventMap(m);
  }

  /** Clip gain for an event (its manifest `clip_gain`), or 1.0. */
  clipGainFor(eventId: string): number {
    return this.events.get(eventId)?.clipGain ?? 1.0;
  }

  get(eventId: string): EventDef | undefined {
    return this.events.get(eventId);
  }

  has(eventId: string): boolean {
    return this.events.has(eventId);
  }

  ids(): string[] {
    return [...this.events.keys()];
  }

  get size(): number {
    return this.events.size;
  }
}
