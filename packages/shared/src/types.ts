/**
 * Shared domain types used by both the BFF and the React frontend.
 */

/** Role tag distinguishing production devices from spare (cold-standby)
 *  devices. Spares are swapped in to replace a failed production device. */
export type Role = "production" | "spare";

/** Japanese labels shown in the UI and stored as the Kintone dropdown value. */
export const ROLE_LABELS: Record<Role, string> = {
  production: "本番",
  spare: "予備",
};

import type { DeviceDetection } from "./detect.js";

/** A normalized firewall/ACL rule extracted from a device config.
 *  Vendor-specific syntax (Cisco ACL, Juniper filter, Fortinet policy,
 *  YAMAHA ip filter) is mapped to this common shape. */
export interface FirewallRule {
  /** Source vendor that produced this rule (informational). */
  vendor: string;
  /** ACL / filter / policy name the rule belongs to. */
  name: string;
  /** Permit/accept or deny/reject. */
  action: "permit" | "deny";
  /** Protocol: tcp, udp, icmp, ip (=any), etc. */
  protocol: string;
  /** Source address spec: "any", "1.2.3.4", "10.0.0.0/24", or an
   *  object-group / address-book name in quotes. */
  source: string;
  /** Destination address spec (same shape as source). */
  destination: string;
  /** Destination port(s): "80", "80,443", "1024-65535", or "any". */
  port: string;
  /** 1-based source line number, for reference. */
  line: number;
  /** Original raw line text. */
  raw: string;
}

/** Identifier fields attached to every config generation. */
export interface DeviceIdentifiers {
  /** Customer / tenant name. */
  customer: string;
  /** Device hostname. */
  hostname: string;
  /** Management IP address (or subnet) of the device. */
  ipAddress: string;
  /** Free-form purpose / role, e.g. "edge-router", "core-switch". */
  purpose: string;
  /** Hardware serial number of the physical device. Per-version so that
   *  hardware swaps (e.g. spare promoted to production) are trackable. */
  serialNumber: string;
  /** 本番 / 予備 tag. Production and spare are distinct devices. */
  role: Role;
}

/** A single generation (revision) of a device config. */
export interface ConfigVersion {
  /** Kintone record id. */
  id: string;
  /** Revision number assigned within the (customer, hostname, role) series. */
  generation: number;
  /** Normalized config body (comments / blank lines removed). */
  body: string;
  /** SHA-256 hash of the normalized body, used for change detection. */
  hash: string;
  /** Display name of the operator who uploaded this revision. */
  operator: string;
  /** Operator email (from Entra ID), used as a stable key. */
  operatorEmail: string;
  /** Upload timestamp in milliseconds since epoch. */
  createdAt: number;
  /** Optional upload note. */
  note?: string;
  /** Size of the normalized body in bytes. */
  size: number;
  /** Line count of the normalized body. */
  lines: number;
  /** 本番 / 予備 tag of the owning device. */
  role: Role;
  /** Auto-detected vendor/OS/model from the config body (informational). */
  detected?: DeviceDetection;
}

/** A logical device groups all its config generations together.
 *  Production and spare are separate devices even if they share a hostname. */
export interface Device {
  id: string;
  identifiers: DeviceIdentifiers;
  latestGeneration: number;
  latestHash: string;
  /** Kintone record id of the latest generation (for diff deep-links). */
  latestVersionId: string;
  lastUpdatedAt: number;
  lastOperator: string;
  versionCount: number;
}

/** A diff result between two config generations. */
export interface ConfigDiff {
  before: { generation: number; hash: string };
  after: { generation: number; hash: string };
  /** Unified-diff formatted string. */
  patch: string;
  /** Per-line structured diff for rendering. */
  lines: DiffLine[];
  /** Aggregate counts. */
  stats: { added: number; removed: number; unchanged: number };
}

export interface DiffLine {
  type: "added" | "removed" | "unchanged" | "context";
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
}

/** Kinds of operations recorded in the audit log. */
export type AuditAction =
  | "upload"
  | "view"
  | "diff"
  | "download"
  | "delete";

export interface AuditLogEntry {
  id: string;
  operator: string;
  operatorEmail: string;
  action: AuditAction;
  customer?: string;
  hostname?: string;
  generation?: number;
  detail?: string;
  createdAt: number;
}

/** Shape of the authenticated user surfaced to the frontend. */
export interface AuthUser {
  displayName: string;
  email: string;
  tenantId?: string;
  objectId?: string;
}
