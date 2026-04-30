"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import {
  AlertCircle,
  BarChart3,
  Boxes,
  Building2,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  LockKeyhole,
  Mail,
  Server,
  ShieldCheck,
} from "lucide-react"

import { useLogin } from "@/hooks/use-auth"
import { APIError } from "@/lib/error-handler"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const platformHighlights = [
  ["WMS live today", "Warehouse execution ready now"],
  ["Shared platform", "Expand into FF and Retail without rebuild"],
  ["Client portal", "Self-service stock, orders, documents, and billing"],
  ["Billing engine", "3PL-native contract rates and invoicing"],
]

const moduleStatus = [
  ["Live", "GWU WMS"],
  ["Live", "Client Portal"],
  ["Build", "GWU FF"],
  ["Plan", "GWU Retail"],
]

const schema = z.object({
  company_code: z.string().trim().min(2, "Enter your company code"),
  username: z.string().trim().min(3, "Enter your username"),
  password: z.string().min(6, "Enter your password"),
  requested_product: z.enum(["WMS", "FF"]),
  remember_company: z.boolean(),
})

type FormValues = z.infer<typeof schema>

function isWmsRoute(path: string) {
  return (
    path.startsWith("/dashboard") ||
    path.startsWith("/grn") ||
    path.startsWith("/do") ||
    path.startsWith("/stock") ||
    path.startsWith("/gate") ||
    path.startsWith("/admin") ||
    path.startsWith("/finance") ||
    path.startsWith("/reports") ||
    path.startsWith("/labor") ||
    path.startsWith("/integrations") ||
    path.startsWith("/wes") ||
    path.startsWith("/portal")
  )
}

function isFreightRoute(path: string) {
  return path.startsWith("/freight")
}

function loginMessage(error: unknown) {
  if (error instanceof APIError) {
    if (error.code === "PRODUCT_DISABLED") return "This product is not enabled for the selected tenant."
    if (error.status === 401 || error.code === "INVALID_CREDENTIALS") {
      return "We could not verify those sign-in details. Check your company code, username, and password."
    }
    return "Sign-in is temporarily unavailable. Please try again or contact your administrator."
  }
  return "Sign-in is temporarily unavailable. Please try again or contact your administrator."
}

export default function LoginPage() {
  const router = useRouter()
  const loginMutation = useLogin()
  const [showPassword, setShowPassword] = useState(false)
  const [authError, setAuthError] = useState("")

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isValid },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: "onChange",
    defaultValues: {
      company_code: "",
      username: "",
      password: "",
      requested_product: "WMS",
      remember_company: true,
    },
  })

  const [requestedProduct, setRequestedProduct] = useState<"WMS" | "FF">("WMS")
  const [rememberCompany, setRememberCompany] = useState(true)

  useEffect(() => {
    const remembered = window.localStorage.getItem("gwu_wms_company_code")
    if (remembered) {
      setValue("company_code", remembered, { shouldValidate: true })
      setValue("remember_company", true)
    }
  }, [setValue])

  const onSubmit = async (values: FormValues) => {
    setAuthError("")
    try {
      const payload = {
        company_code: values.company_code.trim().toUpperCase(),
        username: values.username.trim(),
        password: values.password,
        requested_product: values.requested_product,
      }
      const loginResult = await loginMutation.mutateAsync(payload)
      if (values.remember_company) {
        window.localStorage.setItem("gwu_wms_company_code", payload.company_code)
      } else {
        window.localStorage.removeItem("gwu_wms_company_code")
      }

      const nextParam =
        typeof window !== "undefined"
          ? String(new URLSearchParams(window.location.search).get("next") || "")
          : ""
      const user = loginResult?.data
      const role = String(user?.role || "").toUpperCase()
      const isPortalOnlyRole =
        role === "CLIENT" ||
        role === "VIEWER" ||
        role === "CUSTOMER" ||
        role === "CLIENT_USER" ||
        role === "READONLY" ||
        role === "READ_ONLY"
      const selectedProduct = values.requested_product
      const defaultRoute = isPortalOnlyRole ? "/portal" : selectedProduct === "FF" ? "/freight" : "/dashboard"

      const isSafePath =
        nextParam.startsWith("/") && !nextParam.startsWith("//") && !nextParam.startsWith("/login")
      const nextMatchesSelectedProduct =
        selectedProduct === "FF" ? isFreightRoute(nextParam) : !isFreightRoute(nextParam)
      const isCrossDomainNext =
        (selectedProduct === "FF" && isWmsRoute(nextParam)) ||
        (selectedProduct === "WMS" && isFreightRoute(nextParam))

      const safeNext =
        isSafePath && nextMatchesSelectedProduct && !isCrossDomainNext ? nextParam : defaultRoute
      router.push(safeNext)
    } catch (error) {
      setAuthError(loginMessage(error))
    }
  }

  return (
    <main className="min-h-screen bg-[#f4f7fb] text-slate-900">
      <div className="grid min-h-screen lg:grid-cols-[1.08fr_0.92fr]">
        <section className="relative hidden overflow-hidden bg-[#06111f] px-12 py-10 text-white lg:flex lg:flex-col lg:justify-between">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_18%,rgba(20,184,166,0.24),transparent_34%),linear-gradient(135deg,rgba(13,33,61,0.92),rgba(4,13,26,0.98)_54%,rgba(7,40,48,0.92))]" />
          <div className="relative">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-white text-lg font-black tracking-tight text-[#06111f]">
                GWU
              </div>
              <div>
                <p className="text-xl font-semibold">GWU Tech</p>
                <p className="text-sm text-slate-300">Supply Chain Operating System</p>
              </div>
            </div>
          </div>

          <div className="relative max-w-2xl">
            <Badge className="mb-5 bg-teal-400/15 text-teal-100">GWU WMS is live today</Badge>
            <h1 className="max-w-xl text-4xl font-semibold leading-tight">
              The supply chain operating system for growing logistics businesses.
            </h1>
            <p className="mt-4 text-base leading-7 text-slate-300">
              Sign in to run inbound, outbound, stock visibility, 3PL billing, labor, and client portal workflows on one reusable GWU platform.
            </p>
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              {platformHighlights.map(([title, detail]) => (
                <div key={title} className="rounded-lg border border-white/10 bg-white/5 p-4">
                  <CheckCircle2 className="mb-3 h-5 w-5 text-emerald-300" />
                  <p className="font-medium">{title}</p>
                  <p className="mt-1 text-sm text-slate-300">{detail}</p>
                </div>
              ))}
            </div>

            <div className="mt-8 overflow-hidden rounded-lg border border-white/10 bg-white/[0.06] p-4 shadow-2xl shadow-black/20">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-white">WMS Operations Dashboard</p>
                  <p className="text-xs text-slate-400">Warehouse, billing, portal, and analytics in one view</p>
                </div>
                <Badge className="bg-emerald-400/15 text-emerald-100">Live</Badge>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  [Boxes, "Stock Visibility", "Live inventory"],
                  [Building2, "3PL Operators", "Multi-client ready"],
                  [BarChart3, "Analytics Cloud", "Cross-module KPIs"],
                ].map(([Icon, title, detail]) => {
                  const DashboardIcon = Icon as typeof Boxes
                  return (
                    <div key={String(title)} className="rounded-lg bg-slate-950/55 p-3">
                      <DashboardIcon className="mb-5 h-5 w-5 text-teal-200" />
                      <p className="text-sm font-medium text-white">{String(title)}</p>
                      <p className="mt-1 text-xs text-slate-400">{String(detail)}</p>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          <div className="relative flex items-center justify-between text-xs text-slate-400">
            <span>Chennai, Tamil Nadu, India</span>
            <span>kornalies.jasupathem@gwutech.com</span>
          </div>
        </section>

        <section className="flex min-h-screen items-center justify-center bg-[#f4f7fb] p-4 sm:p-8">
          <Card className="w-full max-w-md rounded-xl border-slate-200 shadow-xl">
            <CardHeader className="space-y-4 pb-4 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-xl bg-[#06111f] text-xl font-black tracking-tight text-white">
                GWU
              </div>
              <div>
                <p className="text-sm font-medium text-teal-700">GWU Tech</p>
                <CardTitle className="text-3xl font-bold">GWU WMS</CardTitle>
                <p className="mt-2 text-sm text-gray-500">Supply chain OS tenant sign-in</p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                <Badge className="bg-teal-100 text-teal-800">WMS Live</Badge>
                <Badge className="bg-blue-100 text-blue-800">Client Portal</Badge>
                <Badge className="bg-slate-100 text-slate-700">Asia/Kolkata</Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-left">
                {moduleStatus.map(([status, label]) => (
                  <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                    <p className="text-[11px] font-semibold uppercase text-teal-700">{status}</p>
                    <p className="text-xs font-medium text-slate-700">{label}</p>
                  </div>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
                {authError && (
                  <Alert variant="destructive">
                    <AlertCircle />
                    <AlertDescription>{authError}</AlertDescription>
                  </Alert>
                )}

                <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-1">
                  {[
                    { value: "WMS", label: "Warehouse" },
                    { value: "FF", label: "Freight" },
                  ].map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`rounded-md px-3 py-2 text-sm font-medium transition ${
                        requestedProduct === option.value
                          ? "bg-white text-slate-950 shadow-sm"
                          : "text-slate-500 hover:text-slate-900"
                      }`}
                      onClick={() => {
                        const value = option.value as "WMS" | "FF"
                        setRequestedProduct(value)
                        setValue("requested_product", value, { shouldValidate: true })
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
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
                      className="h-12 pl-10 uppercase"
                      autoComplete="organization"
                      autoCapitalize="characters"
                      spellCheck={false}
                      {...register("company_code", {
                        onChange: (event) => {
                          event.target.value = event.target.value.toUpperCase()
                          setAuthError("")
                        },
                      })}
                    />
                  </div>
                  <p className="text-xs text-gray-500">Use the tenant code provided by your administrator.</p>
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
                      onClick={() => setAuthError("Password reset is handled by your tenant administrator.")}
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
                      {...register("password", { onChange: () => setAuthError("") })}
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
                  {errors.password && <p className="text-sm text-red-600">{errors.password.message}</p>}
                </div>

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

                <Button
                  type="submit"
                  className="h-12 w-full bg-slate-950 text-base font-medium hover:bg-slate-800"
                  disabled={loginMutation.isPending || !isValid}
                >
                  {loginMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    "Sign in"
                  )}
                </Button>

                <div className="grid grid-cols-2 gap-2">
                  <Button type="button" variant="outline" disabled className="h-11">
                    <KeyRound className="mr-2 h-4 w-4" />
                    Microsoft
                  </Button>
                  <Button type="button" variant="outline" disabled className="h-11">
                    <ShieldCheck className="mr-2 h-4 w-4" />
                    SSO
                  </Button>
                </div>

                <p className="text-center text-xs text-gray-500">
                  Need access? Contact GWU Tech or your warehouse administrator.
                </p>
                {rememberCompany && (
                  <p className="text-center text-xs text-gray-400">
                    Only the company code is stored on this device.
                  </p>
                )}
                <p className="text-center text-xs text-gray-400">
                  www.gwutech.com | +91 9566935593
                </p>
              </form>
            </CardContent>
          </Card>
        </section>
      </div>
    </main>
  )
}
