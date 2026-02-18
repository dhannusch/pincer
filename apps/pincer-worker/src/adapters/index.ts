import {
  stableStringify,
  validateAdapterManifest,
  type AdapterManifest,
  type AdapterManifestAction,
} from "@pincerclaw/shared-types";

import type { WorkerEnv } from "../types.js";
import type {
  AdapterProposalRecord,
  AdapterProposalSummary,
  ProposalAuditEvent,
  ProposalAuditEventType,
  AdapterRegistryIndex,
  AdapterRuntimeState,
  ApplyManifestResult,
} from "./types.js";

const REGISTRY_INDEX_KEY = "adapter_registry:index";
const PROPOSAL_AUDIT_KEY_PREFIX = "audit:proposal:";
const CACHE_TTL_MS = 10_000;

// TODO: Keep this cache shape aligned with config.ts or extract a shared helper.
const registryCache: {
  loadedAtMs: number;
  kvRef: unknown;
  index: AdapterRegistryIndex | null;
  manifestsByAdapterId: Map<string, AdapterManifest>;
} = {
  loadedAtMs: 0,
  kvRef: null,
  index: null,
  manifestsByAdapterId: new Map(),
};

type RegistrySnapshot = {
  index: AdapterRegistryIndex;
  manifestsByAdapterId: Map<string, AdapterManifest>;
};

export type RegistryOperationError = {
  error: string;
  status: number;
  details?: string[];
  missingSecrets?: string[];
};

type RegistryResult<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: RegistryOperationError;
    };

function createEmptyIndex(): AdapterRegistryIndex {
  return {
    proposals: [],
    active: {},
  };
}

function invalidateRegistryCache(): void {
  registryCache.loadedAtMs = 0;
  registryCache.kvRef = null;
  registryCache.index = null;
  registryCache.manifestsByAdapterId = new Map();
}

function ensureKv(env: WorkerEnv) {
  const kv = env.PINCER_CONFIG_KV;
  if (
    !kv ||
    typeof kv.get !== "function" ||
    typeof kv.put !== "function" ||
    typeof kv.delete !== "function" ||
    typeof kv.list !== "function"
  ) {
    throw new Error("PINCER_CONFIG_KV binding is missing");
  }

  return kv;
}

function readSecretBinding(env: WorkerEnv, bindingName: string): string {
  if (!bindingName || typeof bindingName !== "string") {
    return "";
  }

  const value = env[bindingName];
  return typeof value === "string" ? value : "";
}

function manifestKvKey(adapterId: string, revision: number): string {
  return `adapter_registry:manifest:${adapterId}:${revision}`;
}

function proposalKvKey(proposalId: string): string {
  return `adapter_registry:proposal:${proposalId}`;
}

function proposalAuditKvKey(occurredAt: string, eventId: string): string {
  return `${PROPOSAL_AUDIT_KEY_PREFIX}${occurredAt}:${eventId}`;
}

function randomBase36(length: number): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const chars: string[] = [];
  while (chars.length < length) {
    const bytes = new Uint8Array(length - chars.length);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      // Use rejection sampling so each base36 character is uniformly distributed.
      if (byte >= 252) {
        continue;
      }
      chars.push(alphabet[byte % alphabet.length]);
      if (chars.length === length) {
        break;
      }
    }
  }
  return chars.join("");
}

function createAuditEventId(): string {
  return `ae_${Date.now().toString(36)}_${randomBase36(6)}`;
}

function normalizeReason(reason: unknown): string | undefined {
  if (typeof reason !== "string") {
    return undefined;
  }

  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.slice(0, 500);
}

function parseIndex(raw: string | null): AdapterRegistryIndex {
  if (!raw) {
    return createEmptyIndex();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("adapter_registry:index must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("adapter_registry:index must be an object");
  }

  const candidate = parsed as Record<string, unknown>;
  const proposalsRaw = candidate.proposals;
  const activeRaw = candidate.active;

  if (!Array.isArray(proposalsRaw)) {
    throw new Error("adapter_registry:index.proposals must be an array");
  }

  if (!activeRaw || typeof activeRaw !== "object" || Array.isArray(activeRaw)) {
    throw new Error("adapter_registry:index.active must be an object");
  }

  const proposals: AdapterProposalSummary[] = [];
  for (const [idx, entry] of proposalsRaw.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`adapter_registry:index.proposals[${idx}] must be an object`);
    }

    const proposal = entry as Record<string, unknown>;
    const proposalId = String(proposal.proposalId || "").trim();
    const adapterId = String(proposal.adapterId || "").trim();
    const revision = Number.parseInt(String(proposal.revision || ""), 10);
    const submittedAt = String(proposal.submittedAt || "").trim();
    const submittedBy = String(proposal.submittedBy || "").trim();

    if (!proposalId || !adapterId || !Number.isInteger(revision) || revision <= 0 || !submittedAt || !submittedBy) {
      throw new Error(`adapter_registry:index.proposals[${idx}] has invalid fields`);
    }

    proposals.push({
      proposalId,
      adapterId,
      revision,
      submittedAt,
      submittedBy,
    });
  }

  const activeEntries = activeRaw as Record<string, unknown>;
  const active: AdapterRegistryIndex["active"] = {};
  for (const [adapterId, entry] of Object.entries(activeEntries)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`adapter_registry:index.active.${adapterId} must be an object`);
    }

    const candidateEntry = entry as Record<string, unknown>;
    const revision = Number.parseInt(String(candidateEntry.revision || ""), 10);
    if (typeof candidateEntry.enabled !== "boolean") {
      throw new Error(`adapter_registry:index.active.${adapterId}.enabled must be boolean`);
    }
    const enabled = candidateEntry.enabled;
    const updatedAt = String(candidateEntry.updatedAt || "").trim();

    if (!Number.isInteger(revision) || revision <= 0) {
      throw new Error(`adapter_registry:index.active.${adapterId}.revision must be > 0`);
    }

    if (!updatedAt) {
      throw new Error(`adapter_registry:index.active.${adapterId}.updatedAt is required`);
    }

    active[adapterId] = {
      adapterId,
      revision,
      enabled,
      updatedAt,
    };
  }

  return {
    proposals,
    active,
  };
}

async function writeIndex(env: WorkerEnv, index: AdapterRegistryIndex): Promise<void> {
  const kv = ensureKv(env);
  await kv.put(REGISTRY_INDEX_KEY, JSON.stringify(index));
  invalidateRegistryCache();
}

async function readIndex(env: WorkerEnv): Promise<AdapterRegistryIndex> {
  const kv = ensureKv(env);
  const raw = await kv.get(REGISTRY_INDEX_KEY);
  return parseIndex(raw);
}

function parseProposalRecord(raw: string | null): AdapterProposalRecord | null {
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("proposal record must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("proposal record must be an object");
  }

  const proposal = parsed as Record<string, unknown>;
  const proposalId = String(proposal.proposalId || "").trim();
  const adapterId = String(proposal.adapterId || "").trim();
  const revision = Number.parseInt(String(proposal.revision || ""), 10);
  const submittedAt = String(proposal.submittedAt || "").trim();
  const submittedBy = String(proposal.submittedBy || "").trim();

  const validation = validateAdapterManifest(proposal.manifest);
  if (validation.ok === false) {
    throw new Error(`proposal record ${proposalId}: invalid manifest (${validation.errors.join(", ")})`);
  }

  if (
    !proposalId ||
    !adapterId ||
    !Number.isInteger(revision) ||
    revision <= 0 ||
    !submittedAt ||
    !submittedBy
  ) {
    throw new Error("proposal record has invalid metadata");
  }

  return {
    proposalId,
    adapterId,
    revision,
    submittedAt,
    submittedBy,
    manifest: validation.manifest,
  };
}

function createProposalId(): string {
  return `pr_${Date.now().toString(36)}_${randomBase36(6)}`;
}

function parseProposalAuditEvent(raw: string | null): ProposalAuditEvent | null {
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const event = parsed as Record<string, unknown>;
  const eventId = String(event.eventId || "").trim();
  const eventType = String(event.eventType || "").trim() as ProposalAuditEventType;
  const occurredAt = String(event.occurredAt || "").trim();
  const proposalId = String(event.proposalId || "").trim();
  const adapterId = String(event.adapterId || "").trim();
  const revision = Number.parseInt(String(event.revision || ""), 10);
  const actor = String(event.actor || "").trim();
  const reason = normalizeReason(event.reason);
  const manifestValidation = validateAdapterManifest(event.manifest);

  if (
    !eventId ||
    !occurredAt ||
    !proposalId ||
    !adapterId ||
    !Number.isInteger(revision) ||
    revision <= 0 ||
    !actor ||
    manifestValidation.ok === false
  ) {
    return null;
  }

  if (
    eventType !== "proposal_submitted" &&
    eventType !== "proposal_approved" &&
    eventType !== "proposal_rejected"
  ) {
    return null;
  }

  return {
    eventId,
    eventType,
    occurredAt,
    proposalId,
    adapterId,
    revision,
    actor,
    reason,
    manifest: manifestValidation.manifest,
  };
}

async function writeProposalAuditEvent(
  env: WorkerEnv,
  input: {
    eventType: ProposalAuditEventType;
    proposal: AdapterProposalRecord;
    actor: string;
    reason?: string;
  }
): Promise<ProposalAuditEvent> {
  const kv = ensureKv(env);
  const eventId = createAuditEventId();
  const occurredAt = new Date().toISOString();
  const event: ProposalAuditEvent = {
    eventId,
    eventType: input.eventType,
    occurredAt,
    proposalId: input.proposal.proposalId,
    adapterId: input.proposal.adapterId,
    revision: input.proposal.revision,
    actor: input.actor,
    manifest: input.proposal.manifest,
    reason: normalizeReason(input.reason),
  };

  await kv.put(proposalAuditKvKey(occurredAt, eventId), JSON.stringify(event));
  return event;
}

async function readManifest(
  env: WorkerEnv,
  adapterId: string,
  revision: number
): Promise<AdapterManifest> {
  const kv = ensureKv(env);
  const raw = await kv.get(manifestKvKey(adapterId, revision));
  if (!raw) {
    throw new Error(`missing manifest for adapter '${adapterId}' revision ${revision}`);
  }

  const parsed = JSON.parse(raw);
  const validation = validateAdapterManifest(parsed);
  if (validation.ok === false) {
    throw new Error(`invalid manifest for adapter '${adapterId}': ${validation.errors.join(", ")}`);
  }

  return validation.manifest;
}

async function getRegistrySnapshot(env: WorkerEnv, forceReload = false): Promise<RegistrySnapshot> {
  const kv = ensureKv(env);
  const nowMs = Date.now();
  if (
    !forceReload &&
    registryCache.index &&
    registryCache.kvRef === kv &&
    nowMs - registryCache.loadedAtMs < CACHE_TTL_MS
  ) {
    return {
      index: registryCache.index,
      manifestsByAdapterId: new Map(registryCache.manifestsByAdapterId.entries()),
    };
  }

  const index = await readIndex(env);
  const manifestsByAdapterId = new Map<string, AdapterManifest>();
  for (const [adapterId, active] of Object.entries(index.active)) {
    const manifest = await readManifest(env, adapterId, active.revision);
    manifestsByAdapterId.set(adapterId, manifest);
  }

  registryCache.loadedAtMs = nowMs;
  registryCache.kvRef = kv;
  registryCache.index = index;
  registryCache.manifestsByAdapterId = manifestsByAdapterId;

  return {
    index,
    manifestsByAdapterId: new Map(manifestsByAdapterId.entries()),
  };
}

export async function initRegistryIfMissing(env: WorkerEnv): Promise<void> {
  const kv = ensureKv(env);
  const existing = await kv.get(REGISTRY_INDEX_KEY);
  if (existing) {
    return;
  }

  await kv.put(REGISTRY_INDEX_KEY, JSON.stringify(createEmptyIndex()));
  invalidateRegistryCache();
}

export async function getAdapterAction(
  env: WorkerEnv,
  adapterId: string,
  actionName: string
): Promise<{ adapter: AdapterManifest; action: AdapterManifestAction } | null> {
  const snapshot = await getRegistrySnapshot(env, false);
  const active = snapshot.index.active[adapterId];
  if (!active || !active.enabled) {
    return null;
  }

  const manifest = snapshot.manifestsByAdapterId.get(adapterId);
  if (!manifest) {
    return null;
  }

  const action = manifest.actions[actionName];
  if (!action) {
    return null;
  }

  return { adapter: manifest, action };
}

export async function listActiveAdapterStates(
  env: WorkerEnv,
  forceReload = false
): Promise<Record<string, AdapterRuntimeState>> {
  const snapshot = await getRegistrySnapshot(env, forceReload);
  const states: Record<string, AdapterRuntimeState> = {};

  for (const [adapterId, active] of Object.entries(snapshot.index.active)) {
    const manifest = snapshot.manifestsByAdapterId.get(adapterId);
    states[adapterId] = {
      enabled: active.enabled,
      revision: active.revision,
      updatedAt: active.updatedAt,
      actionCount: manifest ? Object.keys(manifest.actions).length : 0,
      requiredSecrets: manifest ? [...manifest.requiredSecrets] : [],
    };
  }

  return states;
}

export async function listActiveAdapters(env: WorkerEnv): Promise<
  Array<{
    adapterId: string;
    revision: number;
    enabled: boolean;
    updatedAt: string;
    actionNames: string[];
    requiredSecrets: string[];
  }>
> {
  const snapshot = await getRegistrySnapshot(env, false);
  const rows = Object.values(snapshot.index.active).map((entry) => {
    const manifest = snapshot.manifestsByAdapterId.get(entry.adapterId);
    return {
      adapterId: entry.adapterId,
      revision: entry.revision,
      enabled: entry.enabled,
      updatedAt: entry.updatedAt,
      actionNames: manifest ? Object.keys(manifest.actions).sort() : [],
      requiredSecrets: manifest ? [...manifest.requiredSecrets] : [],
    };
  });

  rows.sort((a, b) => a.adapterId.localeCompare(b.adapterId));
  return rows;
}

export async function listEnabledAdapters(env: WorkerEnv): Promise<
  Array<{
    adapterId: string;
    revision: number;
    actionNames: string[];
  }>
> {
  const active = await listActiveAdapters(env);
  return active
    .filter((item) => item.enabled)
    .map((item) => ({
      adapterId: item.adapterId,
      revision: item.revision,
      actionNames: [...item.actionNames],
    }));
}

export async function listAdapterProposals(env: WorkerEnv): Promise<AdapterProposalSummary[]> {
  const index = await readIndex(env);
  return [...index.proposals].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

export async function getAdapterProposal(
  env: WorkerEnv,
  proposalId: string
): Promise<AdapterProposalRecord | null> {
  const kv = ensureKv(env);
  const raw = await kv.get(proposalKvKey(proposalId));
  return parseProposalRecord(raw);
}

export async function submitAdapterProposal(
  env: WorkerEnv,
  manifestRaw: unknown,
  submittedBy: string
): Promise<RegistryResult<AdapterProposalSummary>> {
  const validation = validateAdapterManifest(manifestRaw);
  if (validation.ok === false) {
    return {
      ok: false,
      error: {
        error: "invalid_manifest",
        status: 400,
        details: validation.errors,
      },
    };
  }

  const manifest = validation.manifest;
  const proposalId = createProposalId();
  const submittedAt = new Date().toISOString();

  const record: AdapterProposalRecord = {
    proposalId,
    adapterId: manifest.id,
    revision: manifest.revision,
    submittedAt,
    submittedBy,
    manifest,
  };

  const kv = ensureKv(env);
  await kv.put(proposalKvKey(proposalId), JSON.stringify(record));

  const index = await readIndex(env);
  index.proposals.push({
    proposalId,
    adapterId: manifest.id,
    revision: manifest.revision,
    submittedAt,
    submittedBy,
  });
  await writeIndex(env, index);
  await writeProposalAuditEvent(env, {
    eventType: "proposal_submitted",
    proposal: record,
    actor: submittedBy,
  });

  return {
    ok: true,
    data: {
      proposalId,
      adapterId: manifest.id,
      revision: manifest.revision,
      submittedAt,
      submittedBy,
    },
  };
}

export async function applyAdapterManifest(
  env: WorkerEnv,
  input: { manifestRaw?: unknown; proposalId?: string }
): Promise<RegistryResult<{ result: ApplyManifestResult; manifest: AdapterManifest }>> {
  const usingProposal = typeof input.proposalId === "string" && input.proposalId.trim().length > 0;

  let proposalRecord: AdapterProposalRecord | null = null;
  let manifest: AdapterManifest;

  if (usingProposal) {
    proposalRecord = await getAdapterProposal(env, input.proposalId || "");
    if (!proposalRecord) {
      return {
        ok: false,
        error: {
          error: "proposal_not_found",
          status: 404,
        },
      };
    }

    manifest = proposalRecord.manifest;
  } else {
    const validation = validateAdapterManifest(input.manifestRaw);
    if (validation.ok === false) {
      return {
        ok: false,
        error: {
          error: "invalid_manifest",
          status: 400,
          details: validation.errors,
        },
      };
    }
    manifest = validation.manifest;
  }

  const index = await readIndex(env);
  const active = index.active[manifest.id];

  let updateType: ApplyManifestResult["updateType"] = "new_install";

  if (active) {
    if (manifest.revision < active.revision) {
      return {
        ok: false,
        error: {
          error: "revision_outdated",
          status: 409,
          details: [
            `active revision is ${active.revision}`,
            `provided revision is ${manifest.revision}`,
          ],
        },
      };
    }

    if (manifest.revision === active.revision) {
      const currentManifest = await readManifest(env, manifest.id, manifest.revision);
      const currentHash = stableStringify(currentManifest);
      const nextHash = stableStringify(manifest);
      if (currentHash !== nextHash) {
        return {
          ok: false,
          error: {
            error: "revision_conflict",
            status: 409,
            details: [
              "same revision already exists with different manifest content",
              "bump revision and retry",
            ],
          },
        };
      }

      updateType = active.enabled ? "in_place_update" : "re_enable";
    } else {
      updateType = "in_place_update";
    }
  }

  const missingSecrets = manifest.requiredSecrets.filter(
    (bindingName) => readSecretBinding(env, bindingName).length === 0
  );

  if (missingSecrets.length > 0) {
    return {
      ok: false,
      error: {
        error: "missing_required_secrets",
        status: 400,
        missingSecrets,
      },
    };
  }

  const kv = ensureKv(env);
  await kv.put(manifestKvKey(manifest.id, manifest.revision), JSON.stringify(manifest));

  index.active[manifest.id] = {
    adapterId: manifest.id,
    revision: manifest.revision,
    enabled: true,
    updatedAt: new Date().toISOString(),
  };

  if (proposalRecord) {
    index.proposals = index.proposals.filter((proposal) => proposal.proposalId !== proposalRecord?.proposalId);
    await kv.delete(proposalKvKey(proposalRecord.proposalId));
  }

  await writeIndex(env, index);

  if (proposalRecord) {
    await writeProposalAuditEvent(env, {
      eventType: "proposal_approved",
      proposal: proposalRecord,
      actor: "admin",
    });
  }

  return {
    ok: true,
    data: {
      result: {
        adapterId: manifest.id,
        revision: manifest.revision,
        updateType,
      },
      manifest,
    },
  };
}

export async function disableAdapter(
  env: WorkerEnv,
  adapterId: string
): Promise<RegistryResult<{ adapterId: string; enabled: boolean }>> {
  const index = await readIndex(env);
  const active = index.active[adapterId];
  if (!active) {
    return {
      ok: false,
      error: {
        error: "adapter_not_found",
        status: 404,
      },
    };
  }

  active.enabled = false;
  active.updatedAt = new Date().toISOString();
  await writeIndex(env, index);

  return {
    ok: true,
    data: {
      adapterId,
      enabled: false,
    },
  };
}

export async function enableAdapter(
  env: WorkerEnv,
  adapterId: string
): Promise<RegistryResult<{ adapterId: string; enabled: boolean }>> {
  const index = await readIndex(env);
  const active = index.active[adapterId];
  if (!active) {
    return {
      ok: false,
      error: {
        error: "adapter_not_found",
        status: 404,
      },
    };
  }

  active.enabled = true;
  active.updatedAt = new Date().toISOString();
  await writeIndex(env, index);

  return {
    ok: true,
    data: {
      adapterId,
      enabled: true,
    },
  };
}

export async function getProposalManifestSummary(
  env: WorkerEnv,
  proposalId: string
): Promise<RegistryResult<AdapterProposalRecord>> {
  const proposal = await getAdapterProposal(env, proposalId);
  if (!proposal) {
    return {
      ok: false,
      error: {
        error: "proposal_not_found",
        status: 404,
      },
    };
  }

  return {
    ok: true,
    data: proposal,
  };
}

export async function rejectAdapterProposal(
  env: WorkerEnv,
  proposalId: string,
  reason?: string
): Promise<RegistryResult<{ proposalId: string; status: "rejected"; rejectedAt: string }>> {
  const proposal = await getAdapterProposal(env, proposalId);
  if (!proposal) {
    return {
      ok: false,
      error: {
        error: "proposal_not_found",
        status: 404,
      },
    };
  }

  const index = await readIndex(env);
  index.proposals = index.proposals.filter((entry) => entry.proposalId !== proposalId);
  await writeIndex(env, index);

  const kv = ensureKv(env);
  await kv.delete(proposalKvKey(proposalId));
  const event = await writeProposalAuditEvent(env, {
    eventType: "proposal_rejected",
    proposal,
    actor: "admin",
    reason,
  });

  return {
    ok: true,
    data: {
      proposalId,
      status: "rejected",
      rejectedAt: event.occurredAt,
    },
  };
}

export async function listProposalAuditEvents(
  env: WorkerEnv,
  input: {
    since?: string;
    limit?: number;
  } = {}
): Promise<ProposalAuditEvent[]> {
  const kv = ensureKv(env);
  const since = typeof input.since === "string" && input.since.length > 0 ? input.since : undefined;
  const limit = Number.isInteger(input.limit) ? Math.max(1, Math.min(200, Number(input.limit))) : 50;

  let cursor: string | undefined = undefined;
  const keys: string[] = [];
  do {
    const page = await kv.list({
      prefix: PROPOSAL_AUDIT_KEY_PREFIX,
      limit: 200,
      cursor,
    });
    keys.push(...page.keys.map((item) => item.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const events: ProposalAuditEvent[] = [];
  for (const key of keys) {
    const raw = await kv.get(key);
    const event = parseProposalAuditEvent(raw);
    if (!event) {
      continue;
    }
    if (since && event.occurredAt < since) {
      continue;
    }
    events.push(event);
  }

  events.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  return events.slice(0, limit);
}
