import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { AuthUser } from "@config-manager/shared";
import { apiFetch } from "./apiClient";

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  refresh: async () => {},
  logout: () => {},
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
        logout: () => {
          window.location.href = "/auth/logout";
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
