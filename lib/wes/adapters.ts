type DispatchArgs = {
  commandType: string
  payload: Record<string, unknown>
  equipmentCode: string
}

export type AdapterDispatchResult = {
  accepted: boolean
  adapterRef?: string
  error?: string
}

export interface EquipmentAdapter {
  dispatch(args: DispatchArgs): Promise<AdapterDispatchResult>
}

class MockAdapter implements EquipmentAdapter {
  async dispatch(args: DispatchArgs): Promise<AdapterDispatchResult> {
    const payloadString = JSON.stringify(args.payload || {})
    const shouldFail = /fail|error/i.test(payloadString)
    if (shouldFail) {
      return { accepted: false, error: "Mock adapter simulated failure from payload content" }
    }
    return {
      accepted: true,
      adapterRef: `mock:${args.equipmentCode}:${Date.now()}`,
    }
  }
}

class RestAdapter implements EquipmentAdapter {
  async dispatch(): Promise<AdapterDispatchResult> {
    return { accepted: false, error: "REST adapter is configured but external dispatch is not enabled in this runtime" }
  }
}

class MqttAdapter implements EquipmentAdapter {
  async dispatch(): Promise<AdapterDispatchResult> {
    return { accepted: false, error: "MQTT adapter is configured but broker dispatch is not enabled in this runtime" }
  }
}

const mockAdapter = new MockAdapter()
const restAdapter = new RestAdapter()
const mqttAdapter = new MqttAdapter()

export function resolveAdapter(adapterType: string): EquipmentAdapter {
  const normalized = String(adapterType || "MOCK").toUpperCase()
  if (normalized === "REST") return restAdapter
  if (normalized === "MQTT") return mqttAdapter
  return mockAdapter
}
