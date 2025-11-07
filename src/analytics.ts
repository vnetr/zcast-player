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
  player?: string; // e.g. from manifest item data.player or deviceId
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
    duration?: number; // seconds (or ms if you prefer—your API treats it as opaque)
    status?: "started" | "completed" | string;
    customer?: string;
    user_group?: string;
    actions?: string[];
    // ...any other fields pass through
    [k: string]: any;
  };
};

type SOVRow = {
  kind: "share_of_voice";
  data: {
    sov_id: string; // daily bucket like "<PLAYER>__YYYY-MM-DD"
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
    content_id: string; // "<MEDIA>__YYYY-MM-DD" or similar bucket id
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

const LS_KEY = "zcast.analytics.queue.v1";

class AnalyticsClient {
  private endpointBase = "";
  private token?: string;
  private flushIntervalMs = 3000;
  private maxBatch = 50;
  private maxRetry = 8;
  private backoffBaseMs = 750;
  private timer: any = null;
  private queue: Array<{ row: Row; tries: number }> = [];
  private inflight = false;
  private defaults: Partial<CommonMeta> = {};

  init(cfg: AnalyticsInit) {
    this.endpointBase = cfg.endpointBase.replace(/\/+$/, "");
    this.token = cfg.authToken;
    this.flushIntervalMs = cfg.flushIntervalMs ?? this.flushIntervalMs;
    this.maxBatch = cfg.maxBatch ?? this.maxBatch;
    this.maxRetry = cfg.maxRetry ?? this.maxRetry;
    this.backoffBaseMs = cfg.backoffBaseMs ?? this.backoffBaseMs;
    this.defaults = cfg.defaults ?? {};

    this.restore();
    this.ensureLoop();
    console.log("[analytics] init", {
      endpointBase: this.endpointBase,
      hasToken: !!this.token,
    });
  }

  /** Add a single analytics item (will be batched) */
  enqueue(row: Row) {
    // Apply defaults without overwriting explicit values
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
    this.timer = setInterval(() => this.flushOnce(), this.flushIntervalMs);
    window.addEventListener("beforeunload", () => {
      // Send whatever is left; navigator.sendBeacon if available for a small last batch
      try {
        const slice = this.queue.slice(0, this.maxBatch).map((e) => e.row);
        if (slice.length && "sendBeacon" in navigator) {
          const blob = new Blob([JSON.stringify({ items: slice })], {
            type: "application/json",
          });
          navigator.sendBeacon(this.url(), blob);
        }
      } catch {}
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
    } catch {}
  }

  private persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.queue.slice(0, 5000))); // cap growth
    } catch {}
  }

  private async flushOnce() {
    if (this.inflight) return;
    if (!this.queue.length) return;

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
    // Simple policy: increment tries for each item in the failed batch
    for (let i = 0; i < batch.length; i++) {
      const idx = i; // relative to start of queue
      if (this.queue[idx])
        this.queue[idx].tries = (this.queue[idx].tries ?? 0) + 1;
    }
    // Drop items that exceeded retry budget
    this.queue = this.queue.filter((e) => (e.tries ?? 0) <= this.maxRetry);
    this.persist();

    const triesMax = Math.max(0, ...batch.map((b) => b.tries ?? 0));
    const jitter = Math.floor(Math.random() * 250);
    const delay = Math.min(
      15000,
      this.backoffBaseMs * Math.pow(2, Math.min(triesMax, 6)) + jitter
    );

    // If 4xx (other than 429), probably a bad payload/auth — don’t spin too hard
    if (status >= 400 && status < 500 && status !== 429) {
      await this.sleep(1500);
      return;
    }
    await this.sleep(delay);
  }

  private sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }
}

export const analytics = new AnalyticsClient();

// Convenience factory so you can do: initAnalytics({...})
export function initAnalytics(cfg: AnalyticsInit) {
  analytics.init(cfg);
  return analytics;
}

/** Utilities to build IDs */
export function makeEventId(
  player: string,
  docId: string | number,
  ts: number
) {
  // Stable, readable ID — upsert happens server-side by this key
  return `evt-${player}__${docId}__${ts}`;
}
export function makeDailyKey(
  prefix: string,
  key: string,
  d: Date = new Date()
) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${key}__${yyyy}-${mm}-${dd}`.replace(/\s+/g, "_");
}
