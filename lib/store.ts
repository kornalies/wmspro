import { create } from "zustand"
import { persist } from "zustand/middleware"

import { signInPathForCurrentLocation } from "@/lib/sign-in-path"

interface User {
  id: number
  username: string
  full_name: string
  email: string
  role: string
  warehouse_id?: number
}

interface AuthState {
  user: User | null
  isLoading: boolean
  setUser: (user: User | null) => void
  setLoading: (loading: boolean) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      isLoading: false,
      setUser: (user) => set({ user }),
      setLoading: (loading) => set({ isLoading: loading }),
      logout: () => {
        set({ user: null })
        if (typeof window !== "undefined") {
          window.location.href = signInPathForCurrentLocation()
        }
      },
    }),
    {
      name: "auth-storage",
    }
  )
)
