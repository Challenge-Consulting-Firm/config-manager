/**
 * Role-based access control helpers.
 *
 * Roles (highest privilege wins when a user is in multiple groups):
 *   admin    — destructive ops (delete) + Meraki credential CRUD
 *   operator — upload / promote / meraki import / meta edit
 *   viewer   — read-only (list, diff, search, download-equivalent GETs)
 *
 * Mapping is driven by Entra group object IDs in env:
 *   ENTRA_GROUP_ADMIN_IDS / ENTRA_GROUP_OPERATOR_IDS / ENTRA_GROUP_VIEWER_IDS
 *
 * When none of those are configured the resolver fails closed: production
 * refuses to boot (see assertRoleGroupsConfigured) and non-production falls
 * back to `admin` only so local validation stays usable (Issue #82).
 */

import type { MiddlewareHandler } from "hono";
import {
  hasMinRole,
  type AppRole,
} from "@config-manager/shared";
import type { AppConfig } from "./config.js";
import type { AppEnv } from "./api.js";

/** True when at least one ENTRA_GROUP_*_IDS mapping is present. */
export function roleGroupsConfigured(cfg: AppConfig): boolean {
  const { adminGroupIds, operatorGroupIds, viewerGroupIds } = cfg.entra;
  return (
    adminGroupIds.length + operatorGroupIds.length + viewerGroupIds.length > 0
  );
}

export function resolveRoleFromGroups(
  groupIds: string[],
  cfg: AppConfig,
): AppRole | null {
  const { adminGroupIds, operatorGroupIds, viewerGroupIds } = cfg.entra;

  if (!roleGroupsConfigured(cfg)) {
    // Production never reaches here — loadConfig() refuses to boot without the
    // mapping. Outside production we keep the permissive default so local /
    // staging validation without Entra groups still works.
    return cfg.nodeEnv === "production" ? null : "admin";
  }

  const set = new Set(groupIds);
  if (adminGroupIds.some((id) => set.has(id))) return "admin";
  if (operatorGroupIds.some((id) => set.has(id))) return "operator";
  if (viewerGroupIds.some((id) => set.has(id))) return "viewer";
  return null;
}

/** Hono middleware factory: require the current user to hold at least `role`. */
export function requireRole(role: AppRole): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.var.user;
    if (!user || !hasMinRole(user.role, role)) {
      return c.json(
        {
          error: "forbidden",
          detail: `この操作には ${role} 以上の権限が必要です`,
          required: role,
          actual: user?.role ?? null,
        },
        403,
      );
    }
    await next();
  };
}
