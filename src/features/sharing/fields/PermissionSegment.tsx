// "View only | Can edit | Live" segmented control for a share link.
// `lockedToRead` disables editing (static sites have no write path on
// the share-token side); `collabDisabled` disables live collaboration
// for file kinds that have no realtime surface. The caller keeps
// `value` out of the disabled modes.

import { Segmented } from "@/components/ui/segmented";
import type { SharePermission } from "@/lib/api/client";

const DESCRIPTIONS: Record<SharePermission, string> = {
  read: "Can open and download the link. Cannot change anything.",
  write: "Changes are saved to the file. Each person edits on their own; nothing appears live.",
  collab:
    "Live collaboration. Everyone on this link edits the same drawing in real time (Excalidraw only).",
};

/** One-line help rendered under the segment. */
export const PERMISSION_HINTS = DESCRIPTIONS;

export function PermissionSegment({
  value,
  onChange,
  lockedToRead = false,
  lockedReason = "Static sites can only be shared view-only.",
  collabDisabled = false,
  collabDisabledReason = "Live collaboration is only available for Excalidraw drawings.",
}: {
  value: SharePermission;
  onChange: (next: SharePermission) => void;
  lockedToRead?: boolean;
  lockedReason?: string;
  collabDisabled?: boolean;
  collabDisabledReason?: string;
}) {
  return (
    <Segmented
      ariaLabel="Access"
      value={value}
      onChange={onChange}
      options={[
        { value: "read", label: "View only", title: DESCRIPTIONS.read },
        {
          value: "write",
          label: "Can edit",
          disabled: lockedToRead,
          title: lockedToRead ? lockedReason : DESCRIPTIONS.write,
        },
        {
          value: "collab",
          label: "Live",
          disabled: lockedToRead || collabDisabled,
          title: lockedToRead
            ? lockedReason
            : collabDisabled
              ? collabDisabledReason
              : DESCRIPTIONS.collab,
        },
      ]}
    />
  );
}
