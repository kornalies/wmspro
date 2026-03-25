export type EquipmentState =
  | "OFFLINE"
  | "IDLE"
  | "READY"
  | "BUSY"
  | "CHARGING"
  | "PAUSED"
  | "FAULT"
  | "ESTOP"

type TransitionRule = {
  to: EquipmentState[]
}

const transitions: Record<EquipmentState, TransitionRule> = {
  OFFLINE: { to: ["IDLE", "FAULT"] },
  IDLE: { to: ["READY", "CHARGING", "PAUSED", "FAULT", "ESTOP", "OFFLINE"] },
  READY: { to: ["BUSY", "CHARGING", "PAUSED", "FAULT", "ESTOP", "OFFLINE"] },
  BUSY: { to: ["READY", "PAUSED", "FAULT", "ESTOP", "OFFLINE"] },
  CHARGING: { to: ["IDLE", "READY", "FAULT", "ESTOP", "OFFLINE"] },
  PAUSED: { to: ["READY", "BUSY", "FAULT", "ESTOP", "OFFLINE"] },
  FAULT: { to: ["IDLE", "OFFLINE", "ESTOP"] },
  ESTOP: { to: ["FAULT", "OFFLINE"] },
}

export function canTransition(from: EquipmentState, to: EquipmentState) {
  return transitions[from]?.to.includes(to) || false
}

export function assertTransition(
  from: EquipmentState,
  to: EquipmentState
): { ok: true } | { ok: false; reason: string } {
  if (from === to) return { ok: true }
  if (!canTransition(from, to)) {
    return {
      ok: false,
      reason: `Invalid equipment state transition ${from} -> ${to}`,
    }
  }
  return { ok: true }
}
