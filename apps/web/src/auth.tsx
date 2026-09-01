import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { AuthUser } from "@config-manager/shared";
import { apiFetch } from "./apiClient";

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  refresh: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const res = await apiFetch<{ authenticated: boolean; user?: AuthUser }>(
        "/auth/me",
      );
      setUser(res.authenticated ? res.user ?? null : null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        refresh: load,
        logout: async () => {
          // ログアウトは状態変更なので POST で行う。GET は CSRF Origin guard の
          // 対象外で、外部サイトから強制ログアウトさせられる（Issue #80）。
          // 遷移先（Entra のサインアウト URL）は応答本文で受け取る。
          try {
            const res = await apiFetch<{ redirectTo: string }>(
              "/auth/logout",
              { method: "POST" },
            );
            window.location.href = res.redirectTo;
          } catch {
            // ログアウト要求が失敗しても画面に留まらせない。トップへ戻せば
            // 未認証ならログインへリダイレクトされる。
            window.location.href = "/";
          }
        },
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
