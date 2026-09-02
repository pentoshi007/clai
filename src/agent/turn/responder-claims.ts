import type { ResponderNotification } from "../../tools/jobs.js";

export interface ResponderClaimPorts {
  readonly getPendingNotifications: () => readonly ResponderNotification[];
  readonly releaseClaim: (notificationId: string) => void;
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
    return this.claimed.size;
  }

  ids(): string[] {
    return [...this.claimed];
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
