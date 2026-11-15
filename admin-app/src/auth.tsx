import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getLiveConnection } from "./live/config";
import { ApiError } from "./live/client";

export type AccountRole = "admin" | "operator" | "viewer" | "custom";

export type Account = {
  account_id: string;
  username: string;
  display_name: string;
  role: AccountRole;
  scopes: string[];
  status: "PENDING" | "ACTIVE" | "DISABLED";
  created_at: string;
  updated_at: string;
  approved_by: string | null;
  last_login_at: string | null;
};

type AuthState = {
  status: "loading" | "anonymous" | "authenticated";
  account: Account | null;
  scopes: string[];
};

type AuthValue = AuthState & {
  login: (username: string, password: string) => Promise<void>;
  register: (input: {
    username: string;
    password: string;
    display_name?: string;
  }) => Promise<{ pending: boolean }>;
  logout: () => Promise<void>;
  hasScope: (scope: string) => boolean;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

/**
 * Password policy, mirrored by PCS: longer than 8 characters and contains an
 * uppercase letter, a lowercase letter and a symbol.
 */
export function strongPassword(password: string): boolean {
  return (
    password.length > 8 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

async function authFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getLiveConnection().pcsUrl;
  const res = await fetch(`${base}${path}`, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = ((data as { error?: unknown } | null)?.error ?? {}) as {
      code?: unknown;
      message?: unknown;
      detail?: unknown;
    };
    throw new ApiError(
      res.status,
      String(err.code ?? "HTTP_ERROR"),
      String(err.message ?? `HTTP ${res.status}`),
      err.detail,
    );
  }
  return data as T;
}

/**
 * Browser session state.
 *
 * The session itself is an HttpOnly cookie the page cannot read; this provider
 * only learns who is signed in via /auth/me and keeps the scope list for UI
 * gating. Permissions are still enforced by PCS on every request.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading", account: null, scopes: [] });

  const refresh = useCallback(async () => {
    try {
      const out = await authFetch<{ account: Account | null; scopes?: string[] }>("/api/v1/auth/me");
      // A legacy bearer token (CLI or an injected token) has no account but still
      // carries scopes; keep that path working.
      if (out.account || (out.scopes?.length ?? 0) > 0) {
        setState({ status: "authenticated", account: out.account, scopes: out.scopes ?? [] });
      } else {
        setState({ status: "anonymous", account: null, scopes: [] });
      }
    } catch {
      setState({ status: "anonymous", account: null, scopes: [] });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUnauthorized = () => setState({ status: "anonymous", account: null, scopes: [] });
    window.addEventListener("pcs-unauthorized", onUnauthorized);
    return () => window.removeEventListener("pcs-unauthorized", onUnauthorized);
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const out = await authFetch<{ account: Account; scopes?: string[] }>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    setState({
      status: "authenticated",
      account: out.account,
      scopes: out.scopes ?? out.account.scopes ?? [],
    });
  }, []);

  const register = useCallback(
    async (input: { username: string; password: string; display_name?: string }) => {
      const out = await authFetch<{ account: Account; logged_in: boolean }>(
        "/api/v1/auth/register",
        { method: "POST", body: JSON.stringify(input) },
      );
      if (out.logged_in) await refresh();
      return { pending: !out.logged_in };
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await authFetch("/api/v1/auth/logout", { method: "POST" }).catch(() => undefined);
    setState({ status: "anonymous", account: null, scopes: [] });
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      ...state,
      login,
      register,
      logout,
      refresh,
      hasScope: (scope: string) => state.scopes.includes(scope),
    }),
    [state, login, register, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
