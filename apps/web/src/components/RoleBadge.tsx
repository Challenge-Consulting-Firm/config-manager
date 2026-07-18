import type { Role } from "@config-manager/shared";
import { ROLE_LABELS } from "@config-manager/shared";

/** Colored 本番 / 予備 badge, reused across pages. */
export function RoleBadge({ role, size = "sm" }: { role: Role; size?: "sm" | "xs" }) {
  const cls =
    role === "production"
      ? "bg-emerald-100 text-emerald-700"
      : "bg-amber-100 text-amber-700";
  const pad = size === "xs" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs";
  return (
    <span className={`inline-block rounded font-medium ${cls} ${pad}`}>
      {ROLE_LABELS[role]}
    </span>
  );
}
