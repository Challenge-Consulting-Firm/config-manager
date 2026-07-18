import { Link, NavLink, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { DevicesPage } from "./pages/DevicesPage";
import { DeviceDetailPage } from "./pages/DeviceDetailPage";
import { UploadPage } from "./pages/UploadPage";
import { DiffPage } from "./pages/DiffPage";
import { AuditPage } from "./pages/AuditPage";
import { FirewallPage } from "./pages/FirewallPage";
import { RoutingPage } from "./pages/RoutingPage";
import { AppIcon } from "./components/AppIcon";

export default function App() {
  const { user, loading, logout } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-slate-500">
        読み込み中…
      </div>
    );
  }

  if (!user) {
    // Should normally be redirected by the BFF; offer a manual login link.
    return (
      <div className="flex h-screen items-center justify-center">
        <a
          href="/auth/login"
          className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        >
          Entra ID でログイン
        </a>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <Link to="/" className="flex items-center gap-2 font-semibold text-slate-900">
            <AppIcon className="h-8 w-8 rounded-md" />
            NW Config Manager
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <NavItem to="/">機器一覧</NavItem>
            <NavItem to="/upload">アップロード</NavItem>
            <NavItem to="/audit">作業履歴</NavItem>
          </nav>
          <div className="flex items-center gap-3">
            <div className="text-right text-sm leading-tight">
              <div className="font-medium text-slate-800">{user.displayName}</div>
              <div className="text-xs text-slate-500">{user.email}</div>
            </div>
            <button
              onClick={logout}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            >
              ログアウト
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <Routes>
          <Route path="/" element={<DevicesPage />} />
          <Route path="/devices/:key" element={<DeviceDetailPage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/diff" element={<DiffPage />} />
          <Route path="/versions/:id/firewall" element={<FirewallPage />} />
          <Route path="/versions/:id/routing" element={<RoutingPage />} />
          <Route path="/audit" element={<AuditPage />} />
        </Routes>
      </main>
    </div>
  );
}

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        `rounded-md px-3 py-1.5 ${
          isActive
            ? "bg-blue-50 text-blue-700"
            : "text-slate-600 hover:bg-slate-100"
        }`
      }
    >
      {children}
    </NavLink>
  );
}
