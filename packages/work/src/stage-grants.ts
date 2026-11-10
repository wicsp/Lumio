import type { StagePermissions } from "@lumio/schema";

export interface PendingStageGrant {
  job: string;
  stage?: string;
  permissions: StagePermissions;
}

const accessRank = { read: 0, write: 1, full: 2 } as const;

/** A human may approve fewer privileges than requested, but cannot approve an unrelated privilege here. */
export function withinRequest(approved: StagePermissions, request: StagePermissions): boolean {
  return (approved.access === undefined || (approved.access !== "read" && request.access !== undefined
    && accessRank[approved.access] <= accessRank[request.access]))
    && (approved.git === undefined || (approved.git && request.git === true))
    && (approved.secrets ?? []).every(secret => request.secrets?.includes(secret));
}

export function mergeStageGrant(base: StagePermissions | undefined, grant: StagePermissions): StagePermissions {
  const access = grant.access && (!base?.access || accessRank[grant.access] > accessRank[base.access]) ? grant.access : base?.access;
  return { ...base, ...(access ? { access } : {}), ...(grant.git ? { git: true } : {}),
    ...(grant.secrets?.length ? { secrets: [...new Set([...(base?.secrets ?? []), ...grant.secrets])] } : {}) };
}
