export interface UploadLimiterOptions {
  maxRequestsPerWindow: number;
  windowMs: number;
  maxConcurrentPerClient: number;
  maxConcurrentTotal: number;
  maxClients: number;
  now: () => number;
}

const defaults: UploadLimiterOptions = {
  maxRequestsPerWindow: 8,
  windowMs: 60_000,
  maxConcurrentPerClient: 2,
  maxConcurrentTotal: 4,
  maxClients: 5_000,
  now: Date.now,
};

interface ClientWindow {
  startsAt: number;
  requests: number;
  concurrent: number;
}

export class UploadLimiter {
  private readonly clients = new Map<string, ClientWindow>();
  private active = 0;
  private readonly options: UploadLimiterOptions;

  constructor(options: Partial<UploadLimiterOptions> = {}) {
    this.options = { ...defaults, ...options };
  }

  acquire(clientId: string): (() => void) | null {
    const now = this.options.now();
    for (const [id, window] of this.clients) {
      if (now - window.startsAt >= this.options.windowMs && window.concurrent === 0)
        this.clients.delete(id);
    }

    let client = this.clients.get(clientId);
    if (!client) {
      if (this.clients.size >= this.options.maxClients) return null;
      client = { startsAt: now, requests: 0, concurrent: 0 };
      this.clients.set(clientId, client);
    }
    if (now - client.startsAt >= this.options.windowMs) {
      client.startsAt = now;
      client.requests = 0;
    }
    if (
      client.requests >= this.options.maxRequestsPerWindow ||
      client.concurrent >= this.options.maxConcurrentPerClient ||
      this.active >= this.options.maxConcurrentTotal
    )
      return null;

    client.requests++;
    client.concurrent++;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      client!.concurrent--;
      this.active--;
    };
  }
}
