/**
 * Which sign-in screen a visitor belongs on.
 *
 * There are two, and they are not interchangeable: /login is the staff screen
 * (company code, product toggle, warehouse branding) and /portal/login is the
 * client-facing one. Sending a client to the staff login is not just cosmetic —
 * they arrive at a page about freight forwarding and WES, pick the wrong
 * product toggle, and land somewhere they have no permission for.
 *
 * A leaf module with no imports, because the proxy (edge runtime), the axios
 * interceptor, and client components all need it.
 */
export const STAFF_LOGIN_PATH = "/login"
export const PORTAL_LOGIN_PATH = "/portal/login"

/** True for the portal pages that are reachable without a session. */
export function isPublicPortalPath(pathname: string) {
  return pathname === PORTAL_LOGIN_PATH || pathname === "/portal/activate"
}

/**
 * The sign-in screen matching a path. Used on redirect-to-login, so it takes the
 * path the user was trying to reach rather than any notion of who they are —
 * at 401 time there is no longer a session to ask.
 */
export function signInPathFor(pathname: string) {
  return pathname.startsWith("/portal") ? PORTAL_LOGIN_PATH : STAFF_LOGIN_PATH
}

/** Browser-side convenience for the same decision. */
export function signInPathForCurrentLocation() {
  if (typeof window === "undefined") return STAFF_LOGIN_PATH
  return signInPathFor(window.location.pathname)
}
