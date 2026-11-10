import { SecretName, StagePermissions, type StageAccess } from "@lumio/schema";

const marker = /(?:^|\r?\n)[ \t]*<lumio-permission>([^<>\r\n]+)<\/lumio-permission>[ \t]*(?:\r?\n[ \t]*)*$/;

export function splitPermissionRequest(report: string): { report: string; permission?: StagePermissions } {
  const match = marker.exec(report);
  if (!match) return { report };
  let access: StageAccess | undefined;
  let git = false;
  const secrets = new Set<string>();
  for (const item of match[1]!.trim().split(/[\s,]+/)) {
    if (item === "git") git = true;
    else if (item === "full") access = "full";
    else if (item === "write") access ??= "write";
    else if (item.startsWith("secret:") && SecretName.safeParse(item.slice(7)).success) secrets.add(item.slice(7));
    else return { report };
  }
  const parsed = StagePermissions.safeParse({ ...(access ? { access } : {}), ...(git ? { git: true } : {}),
    ...(secrets.size ? { secrets: [...secrets] } : {}) });
  return parsed.success ? { report: report.slice(0, match.index).trimEnd(), permission: parsed.data } : { report };
}
