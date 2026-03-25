"use client"

import { FormEvent, Suspense, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

type ValidationPayload = {
  valid: boolean
  status: string
  expires_at: string
  user: {
    id: number
    username: string
    full_name: string
    email: string
  }
}

function PortalActivateContent() {
  const searchParams = useSearchParams()
  const token = useMemo(() => String(searchParams.get("token") || "").trim(), [searchParams])
  const [loading, setLoading] = useState(true)
  const [valid, setValid] = useState(false)
  const [statusText, setStatusText] = useState("")
  const [userName, setUserName] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    const run = async () => {
      if (!token) {
        setStatusText("Activation token is missing.")
        setLoading(false)
        return
      }
      try {
        const res = await fetch(`/api/portal/invite/validate?token=${encodeURIComponent(token)}`, {
          cache: "no-store",
        })
        const json = await res.json()
        if (!res.ok || json?.success === false) {
          setStatusText(json?.error?.message || "Invalid activation link.")
          setLoading(false)
          return
        }
        const data = json?.data as ValidationPayload
        setValid(Boolean(data?.valid))
        setUserName(data?.user?.full_name || data?.user?.username || "")
        setStatusText(
          data?.valid
            ? "Set your password to activate portal access."
            : "Activation link is expired or already used."
        )
      } catch {
        setStatusText("Failed to validate activation link.")
      } finally {
        setLoading(false)
      }
    }
    void run()
  }, [token])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    if (password.length < 6) {
      setStatusText("Password must be at least 6 characters.")
      return
    }
    if (password !== confirmPassword) {
      setStatusText("Passwords do not match.")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/portal/invite/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      })
      const json = await res.json()
      if (!res.ok || json?.success === false) {
        setStatusText(json?.error?.message || "Activation failed.")
        return
      }
      setDone(true)
      setStatusText("Account activated successfully. Please login.")
    } catch {
      setStatusText("Activation failed.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle>Portal Activation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? <p className="text-sm text-gray-600">Validating link...</p> : null}
          {!loading ? <p className="text-sm">{statusText}</p> : null}
          {userName ? <p className="text-xs text-gray-500">User: {userName}</p> : null}

          {valid && !done ? (
            <form className="space-y-3" onSubmit={submit}>
              <div className="space-y-1">
                <label className="text-sm">New Password</label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm">Confirm Password</label>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <Button type="submit" className="w-full bg-blue-600" disabled={saving}>
                {saving ? "Activating..." : "Activate Account"}
              </Button>
            </form>
          ) : null}

          {done ? (
            <a href="/login" className="inline-block text-sm font-medium text-blue-700 hover:underline">
              Go to Login
            </a>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

export default function PortalActivatePage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-md px-4 py-10 text-sm text-gray-600">Loading...</div>}>
      <PortalActivateContent />
    </Suspense>
  )
}
