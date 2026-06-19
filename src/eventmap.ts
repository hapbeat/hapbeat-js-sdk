/**
 * EventMap — the tuning side of the SDK, kept orthogonal to the fire side.
 *
 * Mirrors the Unity SDK's EventMap at level-1: a catalog mapping an event id
 * to its default gain (and per-event metadata), linked to firing only by id.
 *
 * The canonical source of per-event default intensity is the kit manifest
 * (schema 2.0.0, hapbeat-contracts/specs/kit-format.md). `intensity` is the
 * recommended baseline gain, read so `hb.play("id")` fires at authored strength.
 */

export interface EventDef {
  eventId: string;
  intensity: number;
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
  parameters?: { intensity?: number; loop?: boolean; device_wiper?: number };
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

  /** Build from a simple `{ eventId: gain }` mapping. */
  static fromGains(gains: Record<string, number>): EventMap {
    const m = new Map<string, EventDef>();
    for (const [eventId, intensity] of Object.entries(gains)) {
      m.set(eventId, { eventId, intensity, loop: false, streaming: false, note: "" });
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
          intensity: p.intensity ?? 1.0,
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

  /** Default gain for an event (its manifest intensity), or 1.0. */
  gainFor(eventId: string): number {
    return this.events.get(eventId)?.intensity ?? 1.0;
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
