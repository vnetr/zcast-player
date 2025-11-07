// src/analytics.ts
// Robust client for POST/GET /api/analytics/ (events | share_of_voice | content)
// - Batching, retry with backoff, offline persistence, ID-based upsert (server handles upsert by *_id).
// - Safe in Electron renderer (no Node). Uses fetch + localStorage.

type Kind = "events" | "share_of_voice" | "content";

export type AnalyticsInit = {
  endpointBase: string; // e.g. "https://carl.zignage.com"
  authToken?: string; // optional Bearer token if your API needs it
  flushIntervalMs?: number; // default 3000
  maxBatch?: number; // default 50
  maxRetry?: number; // default 8
  backoffBaseMs?: number; // default 750
  defaults?: Partial<CommonMeta>;
};

type CommonMeta = {
  player?: string;
  customer?: string;
  user_group?: string;
  tz?: string; // e.g. "America/New_York"
};

type EventRow = {
  kind: "events";
  data: {
    event_id: string;
    timestamp?: string; // ISO
    player?: string;
    schedule?: string;
    media?: string;
    duration?: number; // seconds
    status?: "started" | "completed" | string;
    customer?: string;
    user_group?: string;
    actions?: string[];
    [k: string]: any;
  };
};

type SOVRow = {
  kind: "share_of_voice";
  data: {
    sov_id: string; // "<PLAYER>__YYYY-MM-DD"
    player?: string;
    total_playtime?: number; // seconds in period
    period_start?: string; // ISO
    period_end?: string; // ISO
    customer?: string;
    [k: string]: any;
  };
};

type ContentRow = {
  kind: "content";
  data: {
    content_id: string; // "<MEDIA>__YYYY-MM-DD"
    media?: string;
    type?: string;
    play_count?: number;
    total_duration?: number;
    customer?: string;
    campaign?: string;
    [k: string]: any;
  };
};

type Row = EventRow | SOVRow | ContentRow;

type PlaybackSample = {
  player?: string;
  media?: string;
  duration?: number; // seconds
  customer?: string;
  timestamp?: string; // ISO
};

type ShareOfVoiceData = {
  sov_id: string;
  player: string;
  total_playtime: number;
  period_start: string;
  period_end: string;
  customer?: string;
};

type ContentAggData = {
  content_id: string;
  media: string;
  type?: string;
  play_count: number;
  total_duration: number;
  customer?: string;
  campaign?: string;
};

const LS_KEY = "zcast.analytics.queue.v1";

class AnalyticsClient {
  private endpointBase = "";
  private token?: string;
  private flushIntervalMs = 3000;
  private maxBatch = 50;
  private maxRetry = 8;
  private backoffBaseMs = 750;

  private timer: any = null;
  private inflight = false;
  private queue: Array<{ row: Row; tries: number }> = [];
  private defaults: Partial<CommonMeta> = {};
  private initialized = false;

  // Aggregation state
  private sovAgg = new Map<string, ShareOfVoiceData>();
  private contentAgg = new Map<string, ContentAggData>();
  private aggTimer: ReturnType<typeof setInterval> | null = null;

  init(cfg: AnalyticsInit) {
    this.endpointBase = (cfg.endpointBase || "").replace(/\/+$/, "");
    this.token = cfg.authToken;
    this.flushIntervalMs = cfg.flushIntervalMs ?? this.flushIntervalMs;
    this.maxBatch = cfg.maxBatch ?? this.maxBatch;
    this.maxRetry = cfg.maxRetry ?? this.maxRetry;
    this.backoffBaseMs = cfg.backoffBaseMs ?? this.backoffBaseMs;
    this.defaults = cfg.defaults ?? {};
    this.initialized = true;

    this.restore();
    this.ensureLoop();
    this.ensureAggLoop();

    console.log("[analytics] init", {
      endpointBase: this.endpointBase,
      hasToken: !!this.token,
    });
  }

  /** Add a single analytics item (will be batched) */
  enqueue(row: Row) {
    const d = this.defaults;

    if (row.kind === "events") {
      row.data.player ??= d.player;
      row.data.customer ??= d.customer;
      row.data.user_group ??= d.user_group;
      row.data.tz ??= d.tz;
    } else if (row.kind === "share_of_voice") {
      row.data.player ??= d.player;
      row.data.customer ??= d.customer;
    } else if (row.kind === "content") {
      row.data.customer ??= d.customer;
    }

    console.log(
      "[analytics] enqueue",
      row.kind,
      (row as any).data?.event_id ||
        (row as any).data?.sov_id ||
        (row as any).data?.content_id
    );

    this.queue.push({ row, tries: 0 });
    this.persist();
  }

  /** High-level helpers */
  logEventStart(args: Partial<EventRow["data"]> & { event_id: string }) {
    const { event_id, timestamp, status, actions, ...rest } = args;
    const row: EventRow = {
      kind: "events",
      data: {
        event_id,
        timestamp: timestamp ?? new Date().toISOString(),
        status: status ?? "started",
        actions: actions ?? ["started"],
        ...rest,
      },
    };
    this.enqueue(row);
  }

  logEventCompleted(
    args: Partial<EventRow["data"]> & { event_id: string; duration?: number }
  ) {
    const { event_id, duration, timestamp, status, actions, ...rest } = args;

    const mergedActions = actions
      ? Array.from(new Set([...actions, "finished"]))
      : ["started", "finished"];

    const row: EventRow = {
      kind: "events",
      data: {
        event_id,
        timestamp: timestamp ?? new Date().toISOString(),
        status: status ?? "completed",
        duration,
        actions: mergedActions,
        ...rest,
      },
    };

    this.enqueue(row);

    // Feed aggregates (best-effort)
    try {
      this.recordPlaybackSample({
        player: row.data.player,
        media: row.data.media,
        duration: row.data.duration,
        customer: row.data.customer,
        timestamp: row.data.timestamp,
      });
    } catch (e) {
      console.warn("[analytics] recordPlaybackSample error", e);
    }
  }

  logSOV(args: SOVRow["data"]) {
    this.enqueue({ kind: "share_of_voice", data: args });
  }

  logContentAgg(args: ContentRow["data"]) {
    this.enqueue({ kind: "content", data: args });
  }

  /** Force immediate send (e.g., on quit) */
  async flushNow() {
    await this.flushOnce();
  }

  // --------------- internals ---------------

  private url(): string {
    return `${this.endpointBase}/api/analytics/`;
  }

  private headers(): HeadersInit {
    const h: HeadersInit = { "Content-Type": "application/json" };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  private ensureLoop() {
    if (this.timer) return;
    if (!this.endpointBase) {
      console.warn("[analytics] missing endpointBase; loop not started");
      return;
    }

    this.timer = setInterval(() => {
      this.flushOnce().catch((e) =>
        console.warn("[analytics] flushOnce error", e)
      );
    }, this.flushIntervalMs);

    window.addEventListener("beforeunload", () => {
      try {
        const slice = this.queue.slice(0, this.maxBatch).map((e) => e.row);
        if (slice.length && "sendBeacon" in navigator) {
          const blob = new Blob([JSON.stringify({ items: slice })], {
            type: "application/json",
          });
          navigator.sendBeacon(this.url(), blob);
        }
      } catch {
        // ignore
      }
    });
  }

  private restore() {
    try {
      const txt = localStorage.getItem(LS_KEY);
      if (!txt) return;
      const parsed = JSON.parse(txt);
      if (Array.isArray(parsed)) {
        this.queue = parsed.filter(Boolean);
      }
    } catch {
      // ignore
    }
  }

  private persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.queue.slice(0, 5000)));
    } catch {
      // ignore
    }
  }

  private async flushOnce() {
    if (this.inflight) return;
    if (!this.queue.length) return;
    if (!this.endpointBase) return;

    this.inflight = true;
    try {
      const batch = this.queue.slice(0, this.maxBatch);
      const payload = { items: batch.map((b) => b.row) };

      console.log(
        "[analytics] flush start",
        payload.items.length,
        "->",
        this.url()
      );

      const res = await fetch(this.url(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
        keepalive: true,
      });

      if (res.ok) {
        this.queue.splice(0, batch.length);
        this.persist();
        console.log("[analytics] flush ok");
        return;
      }

      console.warn("[analytics] flush bad status", res.status);
      await this.handleRetry(batch, res.status);
    } catch (e) {
      console.warn("[analytics] flush error", e);
      await this.handleRetry(this.queue.slice(0, this.maxBatch), 0);
    } finally {
      this.inflight = false;
    }
  }

  private async handleRetry(
    batch: Array<{ row: Row; tries: number }>,
    status: number
  ) {
    for (let i = 0; i < batch.length; i++) {
      if (this.queue[i]) {
        this.queue[i].tries = (this.queue[i].tries ?? 0) + 1;
      }
    }

    this.queue = this.queue.filter((e) => (e.tries ?? 0) <= this.maxRetry);
    this.persist();

    const triesMax = Math.max(0, ...batch.map((b) => b.tries ?? 0));
    const jitter = Math.floor(Math.random() * 250);
    const delay = Math.min(
      15000,
      this.backoffBaseMs * Math.pow(2, Math.min(triesMax, 6)) + jitter
    );

    if (status >= 400 && status < 500 && status !== 429) {
      await this.sleep(1500);
      return;
    }

    await this.sleep(delay);
  }

  private sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }

  // -------- Aggregation helpers --------

  private ensureAggLoop() {
    if (this.aggTimer || !this.initialized) return;
    if (!this.endpointBase) return;

    this.aggTimer = setInterval(() => {
      this.flushAggregates().catch((e) =>
        console.warn("[analytics] aggregate flush error", e)
      );
    }, 60_000);
  }

  private dayKeyAndBounds(tsISO?: string): {
    key: string;
    start: string;
    end: string;
  } {
    const d = tsISO ? new Date(tsISO) : new Date();
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const day = d.getUTCDate();

    const start = new Date(Date.UTC(y, m, day, 0, 0, 0, 0));
    const end = new Date(Date.UTC(y, m, day, 23, 59, 59, 999));

    const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(
      2,
      "0"
    )}`;

    return { key, start: start.toISOString(), end: end.toISOString() };
  }

  private recordPlaybackSample(sample: PlaybackSample) {
    const duration = sample.duration || 0;
    if (duration <= 0) return;

    const player = sample.player || this.defaults.player;
    if (!player) return;

    const { key: dayKey, start, end } = this.dayKeyAndBounds(sample.timestamp);

    // Share of Voice
    const sovId = `${player}__${dayKey}`;
    const prevSov = this.sovAgg.get(sovId);
    const sov: ShareOfVoiceData =
      prevSov || {
        sov_id: sovId,
        player,
        total_playtime: 0,
        period_start: start,
        period_end: end,
        customer: sample.customer || this.defaults.customer,
      };

    sov.total_playtime += duration;
    this.sovAgg.set(sovId, sov);

    // Content aggregation
    if (sample.media) {
      const contentId = `${sample.media}__${dayKey}`;
      const prevContent = this.contentAgg.get(contentId);
      const content: ContentAggData =
        prevContent || {
          content_id: contentId,
          media: sample.media,
          type: "layout", // default; adjust later if needed
          play_count: 0,
          total_duration: 0,
          customer: sample.customer || this.defaults.customer,
        };

      content.play_count += 1;
      content.total_duration += duration;
      this.contentAgg.set(contentId, content);
    }

    this.ensureAggLoop();
  }

  private async flushAggregates() {
    if (!this.sovAgg.size && !this.contentAgg.size) return;

    const items: Row[] = [];

    for (const data of this.sovAgg.values()) {
      items.push({ kind: "share_of_voice", data } as SOVRow);
    }
    for (const data of this.contentAgg.values()) {
      items.push({ kind: "content", data } as ContentRow);
    }

    if (!items.length) return;

    for (const row of items) {
      this.enqueue(row);
    }

    this.sovAgg.clear();
    this.contentAgg.clear();
  }
}

export const analytics = new AnalyticsClient();

export function initAnalytics(cfg: AnalyticsInit) {
  analytics.init(cfg);
  return analytics;
}

/** Utilities to build IDs */
export function makeEventId(
  player: string,
  docId: string | number,
  ts: number
): string {
  return `evt-${player}__${docId}__${ts}`;
}

export function makeDailyKey(
  prefix: string,
  key: string,
  d: Date = new Date()
): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${key}__${yyyy}-${mm}-${dd}`.replace(/\s+/g, "_");
}
