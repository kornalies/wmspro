type SecurityEventType =
  | "proxy_invalid_access_token"
  | "proxy_mobile_actor_token_rejected"
  | "mobile_auth_actor_scope_rejected"
  | "mobile_refresh_invalid_token";

type SecurityTelemetrySnapshot = {
  totalEvents: number;
  lastEventAt: string | null;
  lastEventType: SecurityEventType | null;
  eventCounts: Record<SecurityEventType, number>;
};

type SecurityLevel = "normal" | "elevated" | "critical";

type SecurityStatus = {
  level: SecurityLevel;
  totalEvents: number;
  topEvents: Array<{ type: SecurityEventType; count: number }>;
  thresholds: {
    elevatedTotalEvents: number;
    criticalTotalEvents: number;
    elevatedPerEventCount: number;
    criticalPerEventCount: number;
  };
};

const eventCounts: Record<SecurityEventType, number> = {
  proxy_invalid_access_token: 0,
  proxy_mobile_actor_token_rejected: 0,
  mobile_auth_actor_scope_rejected: 0,
  mobile_refresh_invalid_token: 0,
};

let totalEvents = 0;
let lastEventAt: string | null = null;
let lastEventType: SecurityEventType | null = null;

const noisyEvents = new Set<SecurityEventType>([
  "proxy_invalid_access_token",
  "proxy_mobile_actor_token_rejected",
  "mobile_auth_actor_scope_rejected",
  "mobile_refresh_invalid_token",
]);

const SECURITY_THRESHOLDS = {
  elevatedTotalEvents: 20,
  criticalTotalEvents: 100,
  elevatedPerEventCount: 10,
  criticalPerEventCount: 50,
} as const;

const buildStatus = (): SecurityStatus => {
  const topEvents = Object.entries(eventCounts)
    .map(([type, count]) => ({ type: type as SecurityEventType, count }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  let level: SecurityLevel = "normal";
  if (
    totalEvents >= SECURITY_THRESHOLDS.criticalTotalEvents ||
    topEvents.some((e) => e.count >= SECURITY_THRESHOLDS.criticalPerEventCount)
  ) {
    level = "critical";
  } else if (
    totalEvents >= SECURITY_THRESHOLDS.elevatedTotalEvents ||
    topEvents.some((e) => e.count >= SECURITY_THRESHOLDS.elevatedPerEventCount)
  ) {
    level = "elevated";
  }

  return {
    level,
    totalEvents,
    topEvents,
    thresholds: { ...SECURITY_THRESHOLDS },
  };
};

export const securityTelemetry = {
  onEvent(type: SecurityEventType, details?: string) {
    totalEvents += 1;
    eventCounts[type] += 1;
    lastEventAt = new Date().toISOString();
    lastEventType = type;

    if (noisyEvents.has(type) && eventCounts[type] % 10 === 0) {
      console.warn(
        `[SECURITY_ALERT] type=${type} count=${eventCounts[type]} lastEventAt=${lastEventAt}${details ? ` details=${details}` : ""}`
      );
    }
  },
  snapshot(): SecurityTelemetrySnapshot {
    return {
      totalEvents,
      lastEventAt,
      lastEventType,
      eventCounts: { ...eventCounts },
    };
  },
  status(): SecurityStatus {
    return buildStatus();
  },
};

export type { SecurityEventType, SecurityTelemetrySnapshot, SecurityStatus };
