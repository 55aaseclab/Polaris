import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ReviewJsonObject = Record<string, unknown>;

export type ManualReviewPaths = {
  manualList: string;
  nonReview?: string | null;
  output: string;
  state: string;
};

type ReviewStatus = "pending" | "approved" | "rejected";

type ReviewDecision = {
  note: string;
  revision_hash?: string;
  status: ReviewStatus;
  updated_at: string | null;
};

const COLLECTION_STATE_SCHEMA = "clue.data-collection.review-state.v1";
const GENERIC_SCHEMA = "clue.manual-review.v2";
const GENERIC_STATE_SCHEMA = "clue.manual-review.state.v2";
const GENERIC_RESULT_SCHEMA = "clue.manual-review.result.v2";
const COLLECTION_RESULT_SCHEMA = "clue.data-collection.review-output.v1";
const REVIEW_STATUSES = new Set<ReviewStatus>([
  "pending",
  "approved",
  "rejected",
]);
const PORTAL_PRODUCER = { name: "polaris-business-portal" };

function asObject(value: unknown): ReviewJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ReviewJsonObject
    : {};
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  }
  return value;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function fileName(filePath: string): string {
  return path.basename(filePath);
}

function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === "string" && REVIEW_STATUSES.has(value as ReviewStatus);
}

function readJsonObject(filePath: string, label: string): ReviewJsonObject {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} does not exist`);
  }
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} must contain a JSON object`);
    }
    return value as ReviewJsonObject;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
    throw error;
  }
}

function pathDigest(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function requireObjectList(document: ReviewJsonObject, key: string, label: string): ReviewJsonObject[] {
  const value = document[key];
  if (!Array.isArray(value) || value.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
    throw new Error(`${label} must contain a '${key}' array of records`);
  }
  return value as ReviewJsonObject[];
}

function requireString(document: ReviewJsonObject, key: string, label: string): string {
  const value = document[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must contain a non-empty '${key}' string`);
  }
  return value;
}

function sourceManifest(filePath: string, document: ReviewJsonObject): ReviewJsonObject {
  return {
    path: filePath,
    sha256: pathDigest(filePath),
    generated_at: document.generated_at,
    source_output: document.source_output,
    source_run_id: document.source_run_id,
  };
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function writeJsonAtomically(filePath: string, value: ReviewJsonObject): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function sanitizeDecision(value: unknown): ReviewDecision | null {
  const decision = asObject(value);
  if (!isReviewStatus(decision.status)) return null;
  return {
    note: typeof decision.note === "string" ? decision.note.slice(0, 5000) : "",
    status: decision.status,
    updated_at: typeof decision.updated_at === "string" ? decision.updated_at : utcNow(),
  };
}

function stateReviews(state: ReviewJsonObject): ReviewJsonObject {
  const reviews = state.reviews;
  if (reviews === null || typeof reviews !== "object" || Array.isArray(reviews)) {
    throw new Error("review state must contain a reviews object");
  }
  return reviews as ReviewJsonObject;
}

function auditEntries(value: unknown): ReviewJsonObject[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => clone(entry as ReviewJsonObject))
    .slice(-100);
}

function appendAudit(state: ReviewJsonObject, entry: ReviewJsonObject): void {
  const audit = auditEntries(state.audit);
  audit.push(entry);
  state.audit = audit.slice(-100);
}

class CollectionReview {
  private readonly automaticRecords: ReviewJsonObject[];
  private readonly collectionId: string;
  private readonly manualByRecordId = new Map<string, ReviewJsonObject>();
  private readonly manualByReviewKey = new Map<string, ReviewJsonObject>();
  private readonly manualDocument: ReviewJsonObject;
  private readonly manualPath: string;
  private readonly manualRecords: ReviewJsonObject[];
  private readonly nonReviewDocument: ReviewJsonObject;
  private readonly nonReviewPath: string;
  private readonly resultPath: string;
  private readonly reviewKeyByRecordId = new Map<string, string>();
  private readonly sourceRejectedRecords: ReviewJsonObject[];
  private readonly sources: ReviewJsonObject;
  private readonly statePath: string;
  private state: ReviewJsonObject;

  constructor(paths: ManualReviewPaths) {
    if (!paths.nonReview) {
      throw new Error("Customer manual-review-list.json requires non-review-results.json");
    }
    this.manualPath = path.resolve(paths.manualList);
    this.nonReviewPath = path.resolve(paths.nonReview);
    this.statePath = path.resolve(paths.state);
    this.resultPath = path.resolve(paths.output);
    this.manualDocument = readJsonObject(this.manualPath, "manual review input");
    this.nonReviewDocument = readJsonObject(this.nonReviewPath, "non-review input");
    this.collectionId = this.readCollectionId();
    this.manualRecords = requireObjectList(
      this.manualDocument,
      "review_records",
      fileName(this.manualPath),
    );
    this.automaticRecords = requireObjectList(
      this.nonReviewDocument,
      "qualified_without_manual_review",
      fileName(this.nonReviewPath),
    );
    this.sourceRejectedRecords = requireObjectList(
      this.nonReviewDocument,
      "rejected_records",
      fileName(this.nonReviewPath),
    );
    this.indexManualRecords();
    this.sources = {
      manual_review_list: sourceManifest(this.manualPath, this.manualDocument),
      non_review_results: sourceManifest(this.nonReviewPath, this.nonReviewDocument),
    };
    this.state = this.loadState();
  }

  bootstrap(): ReviewJsonObject {
    return {
      collection_id: this.collectionId,
      paths: {
        result_file: this.resultPath,
        state_file: this.statePath,
      },
      qualified_without_manual_review: clone(this.automaticRecords),
      rejected_records: clone(this.sourceRejectedRecords),
      review_records: clone(this.manualRecords),
      reviews: this.decisionsForBrowser(),
      sources: clone(this.sources),
      summary: this.summary(),
      tool: clone(PORTAL_PRODUCER),
    };
  }

  exportResults(): ReviewJsonObject {
    const approved: ReviewJsonObject[] = [];
    const rejected: ReviewJsonObject[] = [];
    const pending: ReviewJsonObject[] = [];
    for (const record of this.manualRecords) {
      const recordId = requireString(record, "record_id", fileName(this.manualPath));
      const decision = this.decisionForRecordId(recordId);
      const reviewed = this.reviewedRecord(record, decision.status);
      if (decision.status === "approved") approved.push(reviewed);
      else if (decision.status === "rejected") rejected.push(reviewed);
      else pending.push(reviewed);
    }
    const automaticReady = this.automaticRecords.map((record) => ({
      ...clone(record),
      manual_review: {
        note: "Automatically qualified; no manual review was required.",
        status: "not_required",
        updated_at: null,
      },
    }));
    const payload: ReviewJsonObject = {
      collection_id: this.collectionId,
      generated_at: utcNow(),
      manually_rejected_records: rejected,
      outreach_ready_records: [...automaticReady, ...approved],
      pending_manual_review_records: pending,
      producer: clone(PORTAL_PRODUCER),
      review_state: {
        identity_strategy: "deduplication.duplicate_group_id (fallback: record_id)",
        path: this.statePath,
        updated_at: this.state.updated_at,
      },
      schema_version: COLLECTION_RESULT_SCHEMA,
      source_rejected_records: clone(this.sourceRejectedRecords),
      sources: clone(this.sources),
      summary: this.summary(),
    };
    writeJsonAtomically(this.resultPath, payload);
    return {
      manually_rejected_count: rejected.length,
      output: this.resultPath,
      outreach_ready_count: automaticReady.length + approved.length,
      pending_manual_review_count: pending.length,
      summary: payload.summary,
    };
  }

  update(recordId: string, status: unknown, note: unknown): ReviewJsonObject {
    if (!this.manualByRecordId.has(recordId)) {
      throw new Error("record_id is not in the manual review list");
    }
    if (!isReviewStatus(status)) {
      throw new Error("status must be pending, approved or rejected");
    }
    if (typeof note !== "string" || note.length > 5000) {
      throw new Error("note must be a string up to 5000 characters");
    }
    const reviewKey = this.reviewKeyByRecordId.get(recordId);
    if (!reviewKey) throw new Error("record_id is not in the manual review list");
    const decision: ReviewDecision = { note, status, updated_at: utcNow() };
    const reviews = stateReviews(this.state);
    if (status === "pending" && !note.trim()) delete reviews[reviewKey];
    else reviews[reviewKey] = decision;
    appendAudit(this.state, {
      action: "review_saved",
      at: decision.updated_at,
      record_id: recordId,
      review_key: reviewKey,
      status,
    });
    this.persistState();
    return { review: this.decisionForRecordId(recordId), summary: this.summary() };
  }

  private decisionForRecordId(recordId: string): ReviewDecision {
    const reviewKey = this.reviewKeyByRecordId.get(recordId);
    const decision = reviewKey ? sanitizeDecision(stateReviews(this.state)[reviewKey]) : null;
    return decision ?? { note: "", status: "pending", updated_at: null };
  }

  private decisionsForBrowser(): ReviewJsonObject {
    const decisions: ReviewJsonObject = {};
    for (const recordId of this.manualByRecordId.keys()) {
      const decision = this.decisionForRecordId(recordId);
      if (decision.status !== "pending" || decision.note) decisions[recordId] = decision;
    }
    return decisions;
  }

  private emptyState(): ReviewJsonObject {
    const now = utcNow();
    return {
      audit: [],
      collection_id: this.collectionId,
      created_at: now,
      producer: clone(PORTAL_PRODUCER),
      reviews: {},
      schema_version: COLLECTION_STATE_SCHEMA,
      sources: clone(this.sources),
      updated_at: now,
    };
  }

  private indexManualRecords(): void {
    for (const record of this.manualRecords) {
      const recordId = requireString(record, "record_id", fileName(this.manualPath));
      if (this.manualByRecordId.has(recordId)) {
        throw new Error(`${fileName(this.manualPath)} has duplicate record_id: ${recordId}`);
      }
      const reviewKey = this.reviewKeyForRecord(record);
      if (this.manualByReviewKey.has(reviewKey)) {
        throw new Error(
          `${fileName(this.manualPath)} has duplicate durable review identity: ${reviewKey}`,
        );
      }
      this.manualByRecordId.set(recordId, record);
      this.manualByReviewKey.set(reviewKey, record);
      this.reviewKeyByRecordId.set(recordId, reviewKey);
    }
  }

  private loadState(): ReviewJsonObject {
    if (!fs.existsSync(this.statePath)) return this.emptyState();
    const state = readJsonObject(this.statePath, "review state");
    const stateSchema = state.schema_version;
    if (stateSchema !== COLLECTION_STATE_SCHEMA) {
      throw new Error("review state has an unsupported schema_version");
    }
    if (state.collection_id !== this.collectionId) {
      throw new Error("review state belongs to another collection_id; choose another state path");
    }
    const rawReviews = stateReviews(state);
    const reviews: ReviewJsonObject = {};
    let migratedLegacyKeys = 0;
    for (const [storedKey, value] of Object.entries(rawReviews)) {
      const reviewKey = this.manualByReviewKey.has(storedKey)
        ? storedKey
        : this.reviewKeyByRecordId.get(storedKey);
      if (!reviewKey) continue;
      const decision = sanitizeDecision(value);
      if (!decision) continue;
      reviews[reviewKey] = decision;
      if (storedKey !== reviewKey) migratedLegacyKeys += 1;
    }
    const refreshed = this.emptyState();
    if (typeof state.created_at === "string") refreshed.created_at = state.created_at;
    refreshed.reviews = reviews;
    refreshed.audit = auditEntries(state.audit);
    if (!equalJson(state.sources, this.sources)) {
      appendAudit(refreshed, {
        action: "source_reconciled",
        at: utcNow(),
        detail: "Source result files changed; matching decisions were retained.",
      });
    }
    if (migratedLegacyKeys) {
      appendAudit(refreshed, {
        action: "review_identity_migrated",
        at: utcNow(),
        detail: `Migrated ${migratedLegacyKeys} saved decision(s) to stable review keys.`,
      });
    }
    return refreshed;
  }

  private persistState(): void {
    this.state.updated_at = utcNow();
    this.state.sources = clone(this.sources);
    writeJsonAtomically(this.statePath, this.state);
  }

  private readCollectionId(): string {
    const manualId = requireString(this.manualDocument, "collection_id", fileName(this.manualPath));
    if (this.nonReviewDocument.collection_id !== manualId) {
      throw new Error("manual-review-list.json and non-review-results.json belong to different collection_id values");
    }
    return manualId;
  }

  private reviewKeyForRecord(record: ReviewJsonObject): string {
    const deduplication = asObject(record.deduplication);
    const candidateId = deduplication.duplicate_group_id;
    if (typeof candidateId === "string" && candidateId.trim()) {
      return `candidate:${candidateId}`;
    }
    return `record:${requireString(record, "record_id", fileName(this.manualPath))}`;
  }

  private reviewedRecord(record: ReviewJsonObject, status: ReviewStatus): ReviewJsonObject {
    const recordId = requireString(record, "record_id", fileName(this.manualPath));
    return {
      ...clone(record),
      manual_review: { ...this.decisionForRecordId(recordId), status },
    };
  }

  private summary(): ReviewJsonObject {
    const counts: Record<ReviewStatus, number> = {
      approved: 0,
      pending: 0,
      rejected: 0,
    };
    for (const recordId of this.manualByRecordId.keys()) {
      counts[this.decisionForRecordId(recordId).status] += 1;
    }
    return {
      automatic_qualified: this.automaticRecords.length,
      manual_review_approved: counts.approved,
      manual_review_pending: counts.pending,
      manual_review_rejected: counts.rejected,
      manual_review_total: this.manualRecords.length,
      source_rejected: this.sourceRejectedRecords.length,
    };
  }
}

class GenericReview {
  private readonly manualByRecordId = new Map<string, ReviewJsonObject>();
  private readonly manualDocument: ReviewJsonObject;
  private readonly manualPath: string;
  private readonly manualRecords: ReviewJsonObject[];
  private readonly resultPath: string;
  private readonly reviewKeyByRecordId = new Map<string, string>();
  private readonly reviewKind: string;
  private readonly reviewSetId: string;
  private readonly revisionByReviewKey = new Map<string, string>();
  private readonly sources: ReviewJsonObject;
  private readonly statePath: string;
  private state: ReviewJsonObject;

  constructor(paths: ManualReviewPaths) {
    this.manualPath = path.resolve(paths.manualList);
    this.statePath = path.resolve(paths.state);
    this.resultPath = path.resolve(paths.output);
    this.manualDocument = readJsonObject(this.manualPath, "manual review input");
    if (this.manualDocument.schema_version !== GENERIC_SCHEMA) {
      throw new Error(`${fileName(this.manualPath)} must use schema_version ${GENERIC_SCHEMA}`);
    }
    this.reviewSetId = requireString(this.manualDocument, "review_set_id", fileName(this.manualPath));
    this.reviewKind = requireString(this.manualDocument, "review_kind", fileName(this.manualPath));
    this.manualRecords = requireObjectList(
      this.manualDocument,
      "review_records",
      fileName(this.manualPath),
    );
    this.indexManualRecords();
    this.sources = {
      manual_review_list: sourceManifest(this.manualPath, this.manualDocument),
    };
    this.state = this.loadState();
  }

  bootstrap(): ReviewJsonObject {
    return {
      paths: {
        result_file: this.resultPath,
        state_file: this.statePath,
      },
      review_kind: this.reviewKind,
      review_records: clone(this.manualRecords),
      review_set_id: this.reviewSetId,
      reviews: this.decisionsForBrowser(),
      sources: clone(this.sources),
      summary: this.summary(),
      tool: clone(PORTAL_PRODUCER),
    };
  }

  exportResults(): ReviewJsonObject {
    const grouped: Record<ReviewStatus, ReviewJsonObject[]> = {
      approved: [],
      pending: [],
      rejected: [],
    };
    for (const [recordId, record] of this.manualByRecordId) {
      const decision = this.decisionForRecordId(recordId);
      grouped[decision.status].push({
        ...clone(record),
        manual_review: { ...decision, status: decision.status },
      });
    }
    const payload: ReviewJsonObject = {
      approval_mode: "manual",
      approved_records: grouped.approved,
      generated_at: utcNow(),
      pending_records: grouped.pending,
      producer: clone(PORTAL_PRODUCER),
      rejected_records: grouped.rejected,
      review_kind: this.reviewKind,
      review_set_id: this.reviewSetId,
      review_state: {
        identity_strategy: "review_key plus revision_hash",
        path: this.statePath,
        updated_at: this.state.updated_at,
      },
      schema_version: GENERIC_RESULT_SCHEMA,
      sources: clone(this.sources),
      summary: this.summary(),
    };
    writeJsonAtomically(this.resultPath, payload);
    return {
      approved_count: grouped.approved.length,
      output: this.resultPath,
      pending_count: grouped.pending.length,
      rejected_count: grouped.rejected.length,
      summary: payload.summary,
    };
  }

  update(recordId: string, status: unknown, note: unknown): ReviewJsonObject {
    if (!this.manualByRecordId.has(recordId)) {
      throw new Error("record_id is not in the manual review list");
    }
    if (!isReviewStatus(status)) {
      throw new Error("status must be pending, approved or rejected");
    }
    if (typeof note !== "string" || note.length > 5000) {
      throw new Error("note must be a string up to 5000 characters");
    }
    const reviewKey = this.reviewKeyByRecordId.get(recordId);
    const revisionHash = reviewKey ? this.revisionByReviewKey.get(reviewKey) : null;
    if (!reviewKey || !revisionHash) throw new Error("record_id is not in the manual review list");
    const decision: ReviewDecision = {
      note,
      revision_hash: revisionHash,
      status,
      updated_at: utcNow(),
    };
    const reviews = stateReviews(this.state);
    if (status === "pending" && !note.trim()) delete reviews[reviewKey];
    else reviews[reviewKey] = decision;
    appendAudit(this.state, {
      action: "review_saved",
      at: decision.updated_at,
      record_id: recordId,
      review_key: reviewKey,
      status,
    });
    this.persistState();
    return { review: this.decisionForRecordId(recordId), summary: this.summary() };
  }

  private decisionForRecordId(recordId: string): ReviewDecision {
    const reviewKey = this.reviewKeyByRecordId.get(recordId);
    const decision = reviewKey ? sanitizeDecision(stateReviews(this.state)[reviewKey]) : null;
    const revisionHash = reviewKey ? this.revisionByReviewKey.get(reviewKey) : undefined;
    return decision
      ? { ...decision, ...(revisionHash ? { revision_hash: revisionHash } : {}) }
      : { note: "", status: "pending", updated_at: null };
  }

  private decisionsForBrowser(): ReviewJsonObject {
    const decisions: ReviewJsonObject = {};
    for (const recordId of this.manualByRecordId.keys()) {
      const decision = this.decisionForRecordId(recordId);
      if (decision.status !== "pending" || decision.note) decisions[recordId] = decision;
    }
    return decisions;
  }

  private emptyState(): ReviewJsonObject {
    const now = utcNow();
    return {
      audit: [],
      created_at: now,
      producer: clone(PORTAL_PRODUCER),
      review_kind: this.reviewKind,
      review_set_id: this.reviewSetId,
      reviews: {},
      schema_version: GENERIC_STATE_SCHEMA,
      sources: clone(this.sources),
      updated_at: now,
    };
  }

  private indexManualRecords(): void {
    for (const record of this.manualRecords) {
      const label = fileName(this.manualPath);
      const recordId = requireString(record, "record_id", label);
      const reviewKey = requireString(record, "review_key", label);
      const revisionHash = requireString(record, "revision_hash", label);
      requireString(record, "title", label);
      requireString(record, "summary", label);
      const evidence = requireObjectList(record, "evidence", label);
      for (const item of evidence) {
        requireString(item, "source_url", label);
        requireString(item, "source_excerpt", label);
        requireString(item, "observed_at", label);
      }
      if (this.manualByRecordId.has(recordId)) {
        throw new Error(`${label} has duplicate record_id: ${recordId}`);
      }
      if (this.revisionByReviewKey.has(reviewKey)) {
        throw new Error(`${label} has duplicate review_key: ${reviewKey}`);
      }
      this.manualByRecordId.set(recordId, record);
      this.reviewKeyByRecordId.set(recordId, reviewKey);
      this.revisionByReviewKey.set(reviewKey, revisionHash);
    }
  }

  private loadState(): ReviewJsonObject {
    if (!fs.existsSync(this.statePath)) return this.emptyState();
    const state = readJsonObject(this.statePath, "review state");
    if (state.schema_version !== GENERIC_STATE_SCHEMA) {
      throw new Error("review state has an unsupported schema_version");
    }
    if (state.review_set_id !== this.reviewSetId || state.review_kind !== this.reviewKind) {
      throw new Error("review state belongs to another review_set_id or review_kind");
    }
    const rawReviews = stateReviews(state);
    const reviews: ReviewJsonObject = {};
    let invalidated = 0;
    for (const [reviewKey, revisionHash] of this.revisionByReviewKey) {
      const stored = asObject(rawReviews[reviewKey]);
      const decision = sanitizeDecision(stored);
      if (!decision) continue;
      if (stored.revision_hash !== revisionHash) {
        invalidated += 1;
        continue;
      }
      reviews[reviewKey] = { ...decision, revision_hash: revisionHash };
    }
    const refreshed = this.emptyState();
    if (typeof state.created_at === "string") refreshed.created_at = state.created_at;
    refreshed.reviews = reviews;
    refreshed.audit = auditEntries(state.audit);
    if (!equalJson(state.sources, this.sources)) {
      appendAudit(refreshed, {
        action: "source_reconciled",
        at: utcNow(),
        detail: "Review input changed; matching finding decisions were retained.",
      });
    }
    if (invalidated) {
      appendAudit(refreshed, {
        action: "review_revision_invalidated",
        at: utcNow(),
        detail: `Invalidated ${invalidated} decision(s) because their finding revision changed.`,
      });
    }
    return refreshed;
  }

  private persistState(): void {
    this.state.updated_at = utcNow();
    this.state.sources = clone(this.sources);
    writeJsonAtomically(this.statePath, this.state);
  }

  private summary(): ReviewJsonObject {
    const counts: Record<ReviewStatus, number> = {
      approved: 0,
      pending: 0,
      rejected: 0,
    };
    for (const recordId of this.manualByRecordId.keys()) {
      counts[this.decisionForRecordId(recordId).status] += 1;
    }
    return {
      approved: counts.approved,
      pending: counts.pending,
      rejected: counts.rejected,
      review_total: this.manualRecords.length,
    };
  }
}

function createReview(paths: ManualReviewPaths): CollectionReview | GenericReview {
  const document = readJsonObject(path.resolve(paths.manualList), "manual review input");
  return document.schema_version === GENERIC_SCHEMA
    ? new GenericReview(paths)
    : new CollectionReview(paths);
}

export function bootstrapManualReview(paths: ManualReviewPaths): ReviewJsonObject {
  return createReview(paths).bootstrap();
}

export function exportManualReview(paths: ManualReviewPaths): ReviewJsonObject {
  return createReview(paths).exportResults();
}

export function saveManualReview(
  paths: ManualReviewPaths,
  recordId: string,
  status: unknown,
  note: unknown,
): ReviewJsonObject {
  if (!recordId.trim()) throw new Error("Review request requires record_id");
  return createReview(paths).update(recordId, status, note);
}
