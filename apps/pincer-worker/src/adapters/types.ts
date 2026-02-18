import type { AdapterManifest } from "@pincer/shared-types";

export type AdapterProposalSummary = {
  proposalId: string;
  adapterId: string;
  revision: number;
  submittedAt: string;
  submittedBy: string;
};

export type AdapterProposalRecord = AdapterProposalSummary & {
  manifest: AdapterManifest;
};

export type ActiveAdapterRecord = {
  adapterId: string;
  revision: number;
  enabled: boolean;
  updatedAt: string;
};

export type AdapterRegistryIndex = {
  proposals: AdapterProposalSummary[];
  active: Record<string, ActiveAdapterRecord>;
};

export type AdapterRuntimeState = {
  enabled: boolean;
  revision: number;
  updatedAt: string;
  actionCount: number;
  requiredSecrets: string[];
};

export type ApplyManifestResult = {
  adapterId: string;
  revision: number;
  updateType: "new_install" | "in_place_update" | "re_enable";
};

export type ProposalAuditEventType =
  | "proposal_submitted"
  | "proposal_approved"
  | "proposal_rejected";

export type ProposalAuditEvent = {
  eventId: string;
  eventType: ProposalAuditEventType;
  occurredAt: string;
  proposalId: string;
  adapterId: string;
  revision: number;
  actor: string;
  reason?: string;
  manifest: AdapterManifest;
};
