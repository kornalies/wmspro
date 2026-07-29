import axios from "axios"

const api = axios.create({
  baseURL: "/api",
  headers: {
    "Content-Type": "application/json",
  },
  withCredentials: true,
})

api.interceptors.request.use(
  (config) => config,
  (error) => Promise.reject(error)
)

api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    if (error.response?.status === 401 && typeof window !== "undefined") {
      window.location.href = "/login"
    }

    const responseData = error.response?.data

    // Routes fail via lib/api-response.ts, whose envelope nests the text one
    // level down as { error: { code, message } }. Older/plain responses put a
    // bare string on `error`, so both shapes have to be unwrapped here — taking
    // the object as-is is what used to render "[object Object]" to operators.
    const envelope = responseData?.error
    const envelopeMessage =
      typeof envelope === "string"
        ? envelope
        : typeof envelope?.message === "string"
          ? envelope.message
          : ""

    const message =
      (typeof responseData === "string" && responseData) ||
      envelopeMessage ||
      responseData?.message ||
      (Array.isArray(responseData?.errors) &&
        responseData.errors
          .map((item: { message?: string } | string) =>
            typeof item === "string" ? item : item?.message
          )
          .filter(Boolean)
          .join(", ")) ||
      (error.request && "Network error: unable to reach server") ||
      error.message ||
      "An error occurred"

    return Promise.reject(new Error(String(message)))
  }
)

export default api
