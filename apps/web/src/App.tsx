import { Link, NavLink, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { DevicesPage } from "./pages/DevicesPage";
import { DeviceDetailPage } from "./pages/DeviceDetailPage";
import { UploadPage } from "./pages/UploadPage";
import { MerakiImportPage } from "./pages/MerakiImportPage";
import { MerakiCredentialsPage } from "./pages/MerakiCredentialsPage";
import { DiffPage } from "./pages/DiffPage";
import { SearchPage } from "./pages/SearchPage";
import { AuditPage } from "./pages/AuditPage";
import { FirewallPage } from "./pages/FirewallPage";
import { RoutingPage } from "./pages/RoutingPage";
import { WirelessPage } from "./pages/WirelessPage";
import { VlanPage } from "./pages/VlanPage";
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
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-8 text-center shadow-sm">
          <AppIcon className="mx-auto h-14 w-14 rounded-md" />
          <h1 className="mt-4 text-xl font-semibold text-slate-900">
            NW Config Manager
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            ネットワーク機器設定管理システム
          </p>
          <p className="mt-4 text-sm text-slate-600">
            続行するには Entra ID でログインしてください。
          </p>
          <a
            href="/auth/login"
            className="mt-6 inline-block w-full rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          >
            Entra ID でログイン
          </a>
        </div>
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
            <NavItem to="/meraki">Meraki 取得</NavItem>
            <NavItem to="/meraki/credentials">接続情報</NavItem>
            <NavItem to="/search">検索</NavItem>
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
          <Route path="/meraki" element={<MerakiImportPage />} />
          <Route path="/meraki/credentials" element={<MerakiCredentialsPage />} />
          <Route path="/diff" element={<DiffPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/versions/:id/firewall" element={<FirewallPage />} />
          <Route path="/versions/:id/routing" element={<RoutingPage />} />
          <Route path="/versions/:id/wireless" element={<WirelessPage />} />
          <Route path="/versions/:id/vlan" element={<VlanPage />} />
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
