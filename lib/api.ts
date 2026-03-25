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

    const message =
      (typeof responseData === "string" && responseData) ||
      responseData?.error ||
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
