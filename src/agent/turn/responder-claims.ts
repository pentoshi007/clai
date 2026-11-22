import type { ResponderNotification } from "../../tools/jobs.js";

export interface ResponderClaimPorts {
  readonly getPendingNotifications: () => readonly ResponderNotification[];
  readonly releaseClaim: (notificationId: string) => void;
  readonly settleClaim: (notificationId: string) => void;
}

const stillUnread = (
  notification: ResponderNotification | undefined,
): boolean =>
  Boolean(
    notification &&
      notification.responder &&
      !notification.readAt &&
      !notification.analyzedAt &&
      !notification.acknowledgedAt &&
      !notification.archivedAt &&
      !notification.discardedAt,
  );

export class ResponderClaimLedger {
  private readonly claimed = new Map<string, "foreground" | "wake">();

  constructor(private readonly ports: ResponderClaimPorts) {}

  add(notificationId: string, owner: "foreground" | "wake" = "foreground"): void {
    this.claimed.set(notificationId, owner);
  }

  delete(notificationId: string): void {
    this.claimed.delete(notificationId);
  }

  has(notificationId: string): boolean {
    return this.claimed.has(notificationId);
  }

  get size(): number {
    this.dropSettled();
    return this.claimed.size;
  }

  ids(): string[] {
    this.dropSettled();
    return [...this.claimed.keys()];
  }

  private dropSettled(): void {
    if (this.claimed.size === 0) return;
    const pending = new Map(
      this.ports
        .getPendingNotifications()
        .map((notification) => [notification.id, notification]),
    );
    for (const [id, owner] of this.claimed) {
      if (stillUnread(pending.get(id))) continue;
      this.claimed.delete(id);
      if (owner === "foreground") this.ports.releaseClaim(id);
    }
  }

  settleDelivered(): void {
    if (this.claimed.size === 0) return;
    const pending = new Map(
      this.ports
        .getPendingNotifications()
        .map((notification) => [notification.id, notification]),
    );
    for (const [id, owner] of this.claimed) {
      const notification = pending.get(id);
      if (owner !== "foreground" || !notification?.deliveredAt || !stillUnread(notification)) continue;
      this.ports.settleClaim(id);
    }
  }

  release(): void {
    for (const [id, owner] of this.claimed) {
      if (owner === "foreground") this.ports.releaseClaim(id);
    }
    this.claimed.clear();
  }
}
