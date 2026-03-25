export const DO_WAVE_STATUSES = ["DRAFT", "RELEASED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const
export type DOWaveStatus = (typeof DO_WAVE_STATUSES)[number]

export const DO_WAVE_STRATEGIES = ["BATCH", "CLUSTER"] as const
export type DOWaveStrategy = (typeof DO_WAVE_STRATEGIES)[number]

export const DO_PICK_TASK_STATUSES = ["QUEUED", "ASSIGNED", "IN_PROGRESS", "DONE", "CANCELLED"] as const
export type DOPickTaskStatus = (typeof DO_PICK_TASK_STATUSES)[number]
