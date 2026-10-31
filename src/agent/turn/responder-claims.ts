import type { ResponderNotification } from "../../tools/jobs.js";

export interface ResponderClaimPorts {
  readonly getPendingNotifications: () => readonly ResponderNotification[];
  readonly releaseClaim: (notificationId: string) => void;
  readonly settleClaim: (notificationId: string) => void;
}

const deliveryInFlight = (
  notification: ResponderNotification | undefined,
): boolean =>
  Boolean(
    notification?.deliveryStartedAt &&
      !notification.readAt &&
      !notification.analyzedAt &&
      !notification.acknowledgedAt,
  );

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
  private readonly claimed = new Set<string>();

  constructor(private readonly ports: ResponderClaimPorts) {}

  add(notificationId: string): void {
    this.claimed.add(notificationId);
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
    return [...this.claimed];
  }

  private dropSettled(): void {
    if (this.claimed.size === 0) return;
    const pending = new Map(
      this.ports
        .getPendingNotifications()
        .map((notification) => [notification.id, notification]),
    );
    for (const notificationId of [...this.claimed]) {
      if (stillUnread(pending.get(notificationId))) continue;
      this.claimed.delete(notificationId);
      this.ports.releaseClaim(notificationId);
    }
  }

  settleDelivered(): void {
    if (this.claimed.size === 0) return;
    const pending = new Map(
      this.ports
        .getPendingNotifications()
        .map((notification) => [notification.id, notification]),
    );
    for (const notificationId of this.claimed) {
      const notification = pending.get(notificationId);
      if (!notification?.deliveredAt || !stillUnread(notification)) continue;
      this.ports.settleClaim(notificationId);
    }
  }

  release(): void {
    const pending = new Map(
      this.ports
        .getPendingNotifications()
        .map((notification) => [notification.id, notification]),
    );
    for (const notificationId of this.claimed) {
      if (deliveryInFlight(pending.get(notificationId))) continue;
      this.ports.releaseClaim(notificationId);
    }
  }
}
