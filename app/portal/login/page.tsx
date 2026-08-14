"use client"

/**
 * Client portal sign-in.
 *
 * Deliberately separate from /login rather than a skin on it. The staff screen
 * asks a client to choose between Warehouse and Freight, advertises modules they
 * will never see, and on success routes by product — none of which means
 * anything to someone signing in to check their own stock. Splitting the two
 * also lets the tenant hand clients a branded link (?c=ACME) without touching
 * the screen their own operators use.
 *
 * Lives at app/portal/login rather than app/(portal)/portal/login so that it
 * stays outside the portal's authenticated surface, next to app/portal/activate
 * for the same reason.
 */

import { Suspense, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import {
  AlertCircle,
  Boxes,
  Eye,
  EyeOff,
  FileText,
  Info,
  Loader2,
  LockKeyhole,
  Mail,
  Receipt,
  Server,
  Truck,
} from "lucide-react"

import { useLogin } from "@/hooks/use-auth"
import { APIError } from "@/lib/error-handler"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const COMPANY_STORAGE_KEY = "gwu_portal_company_code"

const schema = z.object({
  company_code: z.string().trim().min(2, "Enter your company code"),
  username: z.string().trim().min(3, "Enter your username"),
  password: z.string().min(6, "Enter your password"),
  remember_company: z.boolean(),
})

type FormValues = z.infer<typeof schema>

const portalCapabilities = [
  [Boxes, "Live stock", "See what you hold in the warehouse, by item and batch"],
  [Truck, "Orders", "Track delivery orders from allocation through dispatch"],
  [Receipt, "Billing", "Review invoices, approve them, or raise a dispute"],
  [FileText, "Documents", "Pull GRNs, delivery notes, and statements on demand"],
] as const

/**
 * Roles that /portal admits. Mirrors the check in proxy.ts — worth duplicating
 * because the alternative is signing a warehouse operator in successfully and
 * then bouncing them to a dashboard with no explanation of what went wrong.
 */
const PORTAL_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "CLIENT", "VIEWER", "CUSTOMER", "CLIENT_USER", "READONLY", "READ_ONLY"])

function loginMessage(error: unknown) {
  if (error instanceof APIError) {
    if (error.code === "PRODUCT_DISABLED") {
      return "The portal is not enabled for this account. Please contact your warehouse provider."
    }
    if (error.status === 401 || error.code === "INVALID_CREDENTIALS") {
      return "We could not verify those details. Check your company code, username, and password."
    }
  }
  return "Sign-in is temporarily unavailable. Please try again, or contact your warehouse provider."
}

function PortalLoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const loginMutation = useLogin()
  const [showPassword, setShowPassword] = useState(false)
  const [authError, setAuthError] = useState("")
  const [notice, setNotice] = useState("")
  const [capsLockOn, setCapsLockOn] = useState(false)

  // A tenant can send clients a link with their code already in it. When it is
  // present the field is filled and locked rather than hidden, so the client can
  // still see which account they are signing in to.
  const pinnedCompanyCode = useMemo(() => {
    const raw = String(searchParams.get("c") || searchParams.get("company") || "").trim()
    return raw ? raw.toUpperCase() : ""
  }, [searchParams])

  const {
    register,
    handleSubmit,
    setValue,
    setFocus,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    // onTouched rather than onChange: with the submit button always live,
    // validating on every keystroke means a client sees "Enter your password"
    // after typing one character of it.
    mode: "onTouched",
    defaultValues: {
      company_code: pinnedCompanyCode,
      username: "",
      password: "",
      remember_company: true,
    },
  })

  const [rememberCompany, setRememberCompany] = useState(true)

  useEffect(() => {
    const remembered = pinnedCompanyCode || window.localStorage.getItem(COMPANY_STORAGE_KEY) || ""
    if (remembered) {
      setValue("company_code", remembered.toUpperCase(), { shouldValidate: true })
      if (!pinnedCompanyCode) setValue("remember_company", true)
    }
    // Land the cursor on the first field the visitor actually has to fill. A
    // returning client has their company code already; making them tab past it
    // every time is the kind of small friction that shows up on every login.
    setFocus(remembered ? "username" : "company_code")
  }, [pinnedCompanyCode, setValue, setFocus])

  const sessionScopeError = searchParams.get("error") === "session_scope"

  const onSubmit = async (values: FormValues) => {
    setAuthError("")
    setNotice("")
    try {
      const payload = {
        company_code: values.company_code.trim().toUpperCase(),
        username: values.username.trim(),
        password: values.password,
        requested_product: "WMS" as const,
      }
      const loginResult = await loginMutation.mutateAsync(payload)

      if (values.remember_company) {
        window.localStorage.setItem(COMPANY_STORAGE_KEY, payload.company_code)
      } else {
        window.localStorage.removeItem(COMPANY_STORAGE_KEY)
      }

      const role = String(loginResult?.data?.role || "").toUpperCase()
      if (!PORTAL_ROLES.has(role)) {
        setAuthError("This account is a warehouse staff account. Please sign in at the staff login instead.")
        return
      }

      // Only ever land inside the portal. A `next` pointing anywhere else is
      // either stale or hostile, and this screen has no business honouring it.
      const nextParam = String(searchParams.get("next") || "")
      const isSafeNext =
        nextParam.startsWith("/portal") &&
        !nextParam.startsWith("//") &&
        nextParam !== "/portal/login"

      router.push(isSafeNext ? nextParam : "/portal")
    } catch (error) {
      setAuthError(loginMessage(error))
    }
  }

  return (
    <main className="min-h-screen bg-[#f4f7fb] text-slate-900">
      <div className="grid min-h-screen lg:grid-cols-[1fr_0.95fr]">
        <section className="relative hidden overflow-hidden bg-[#0b2545] px-12 py-10 text-white lg:flex lg:flex-col lg:justify-between">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_75%_20%,rgba(56,189,248,0.22),transparent_38%),linear-gradient(140deg,rgba(11,37,69,0.95),rgba(6,20,38,0.98))]" />

          <div className="relative flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-white text-lg font-black tracking-tight text-[#0b2545]">
              GWU
            </div>
            <div>
              <p className="text-xl font-semibold">Client Portal</p>
              <p className="text-sm text-slate-300">Powered by GWU Tech</p>
            </div>
          </div>

          <div className="relative max-w-xl">
            <h1 className="text-4xl font-semibold leading-tight">Your inventory, your orders, your invoices.</h1>
            <p className="mt-4 text-base leading-7 text-slate-300">
              Sign in to see what your warehouse provider is holding for you — in real time, without waiting on an email.
            </p>

            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              {portalCapabilities.map(([Icon, title, detail]) => (
                <div key={title} className="rounded-lg border border-white/10 bg-white/5 p-4">
                  <Icon className="mb-3 h-5 w-5 text-sky-300" />
                  <p className="font-medium">{title}</p>
                  <p className="mt-1 text-sm text-slate-300">{detail}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="relative text-xs text-slate-400">
            <p>Access is granted by your warehouse provider. Contact them to add or remove users.</p>
          </div>
        </section>

        <section className="flex min-h-screen items-center justify-center bg-[#f4f7fb] p-4 sm:p-8">
          <Card className="w-full max-w-md rounded-xl border-slate-200 shadow-xl">
            <CardHeader className="space-y-3 pb-4 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-xl bg-[#0b2545] text-xl font-black tracking-tight text-white">
                GWU
              </div>
              <div>
                <CardTitle className="text-3xl font-bold">Client Portal</CardTitle>
                <p className="mt-2 text-sm text-gray-500">Sign in to your account</p>
              </div>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
                {/*
                  A live region so a failed sign-in is announced rather than
                  silently repainted -- someone using a screen reader otherwise
                  gets no feedback at all beyond the button becoming clickable
                  again.
                */}
                <div aria-live="polite" role="status" className="empty:hidden space-y-4">
                  {sessionScopeError && !authError && (
                    <Alert variant="destructive">
                      <AlertCircle />
                      <AlertDescription>Your session has ended. Please sign in again.</AlertDescription>
                    </Alert>
                  )}
                  {authError && (
                    <Alert variant="destructive">
                      <AlertCircle />
                      <AlertDescription>{authError}</AlertDescription>
                    </Alert>
                  )}
                  {/* Informational, so deliberately not the destructive variant --
                      clicking "Forgot password?" is not a failure. */}
                  {notice && (
                    <Alert className="border-sky-200 bg-sky-50 text-sky-900">
                      <Info className="text-sky-700" />
                      <AlertDescription className="text-sky-900">{notice}</AlertDescription>
                    </Alert>
                  )}
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700" htmlFor="company_code">
                    Company Code
                  </label>
                  <div className="relative">
                    <Server className="absolute left-3 top-3.5 h-4 w-4 text-gray-400" />
                    <Input
                      id="company_code"
                      type="text"
                      className="h-12 pl-10 uppercase disabled:bg-slate-100 disabled:text-slate-600"
                      autoComplete="organization"
                      autoCapitalize="characters"
                      spellCheck={false}
                      readOnly={Boolean(pinnedCompanyCode)}
                      {...register("company_code", {
                        onChange: (event) => {
                          event.target.value = event.target.value.toUpperCase()
                          setAuthError("")
                        },
                      })}
                    />
                  </div>
                  <p className="text-xs text-gray-500">
                    {pinnedCompanyCode
                      ? "Set by the link you followed."
                      : "The code your warehouse provider gave you."}
                  </p>
                  {errors.company_code && <p className="text-sm text-red-600">{errors.company_code.message}</p>}
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700" htmlFor="username">
                    Username
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-3.5 h-4 w-4 text-gray-400" />
                    <Input
                      id="username"
                      type="text"
                      className="h-12 pl-10"
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                      {...register("username", { onChange: () => setAuthError("") })}
                    />
                  </div>
                  {errors.username && <p className="text-sm text-red-600">{errors.username.message}</p>}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-gray-700" htmlFor="password">
                      Password
                    </label>
                    <button
                      type="button"
                      className="text-sm font-medium text-blue-700 hover:underline"
                      onClick={() => {
                        setAuthError("")
                        setNotice("Password resets are handled by your warehouse provider. Please contact them to have yours reset.")
                      }}
                    >
                      Forgot password?
                    </button>
                  </div>
                  <div className="relative">
                    <LockKeyhole className="absolute left-3 top-3.5 h-4 w-4 text-gray-400" />
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      className="h-12 pl-10 pr-11"
                      autoComplete="current-password"
                      spellCheck={false}
                      // Caps Lock is the single most common cause of a login
                      // that fails against correct credentials, and the field
                      // masks the evidence.
                      onKeyUp={(event) => setCapsLockOn(event.getModifierState?.("CapsLock") ?? false)}
                      {...register("password", {
                        onChange: () => setAuthError(""),
                        onBlur: () => setCapsLockOn(false),
                      })}
                    />
                    <button
                      type="button"
                      className="absolute right-3 top-3 text-gray-500 hover:text-gray-800"
                      onClick={() => setShowPassword((value) => !value)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                    </button>
                  </div>
                  {capsLockOn && (
                    <p className="text-xs font-medium text-amber-700" role="status">
                      Caps Lock is on.
                    </p>
                  )}
                  {errors.password && <p className="text-sm text-red-600">{errors.password.message}</p>}
                </div>

                {!pinnedCompanyCode && (
                  <label className="flex items-center gap-2 text-sm text-gray-600">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-gray-300"
                      checked={rememberCompany}
                      {...register("remember_company")}
                      onChange={(event) => {
                        setRememberCompany(event.target.checked)
                        setValue("remember_company", event.target.checked, { shouldValidate: true })
                      }}
                    />
                    Remember company code on this device
                  </label>
                )}

                {/*
                  Disabled only while the request is in flight, never for an
                  incomplete form. A greyed-out button tells a client that
                  something is wrong but not what; letting the submit through and
                  surfacing the field errors does.
                */}
                <Button
                  type="submit"
                  className="h-12 w-full bg-[#0b2545] text-base font-medium hover:bg-[#123a6b]"
                  disabled={loginMutation.isPending}
                >
                  {loginMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Signing in...
                    </>
                  ) : (
                    "Sign in"
                  )}
                </Button>

                <p className="text-center text-xs text-gray-500">
                  Have an invitation link? Open it to set your password and activate your account.
                </p>
                <p className="text-center text-xs text-gray-400">
                  Warehouse staff:{" "}
                  <a href="/login" className="font-medium text-blue-700 hover:underline">
                    sign in here
                  </a>
                </p>
              </form>
            </CardContent>
          </Card>
        </section>
      </div>
    </main>
  )
}

export default function PortalLoginPage() {
  // useSearchParams needs a Suspense boundary or the whole route opts out of
  // static rendering at build time.
  return (
    <Suspense fallback={<main className="min-h-screen bg-[#f4f7fb]" />}>
      <PortalLoginForm />
    </Suspense>
  )
}
