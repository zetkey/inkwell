// Allow-downloads switch. Editable links (write + live collab) always
// allow downloads — the worker enforces this too — so the switch shows
// on + disabled for them.

import { Toggle } from "@/features/settings/controls";
import type { SharePermission } from "@/lib/api/client";

export function AllowDownloadField({
  permission,
  value,
  onChange,
  id,
}: {
  permission: SharePermission;
  value: boolean;
  onChange: (next: boolean) => void;
  id?: string;
}) {
  const isEditable = permission !== "read";
  return (
    <Toggle
      id={id}
      label="Allow downloads"
      checked={isEditable ? true : value}
      disabled={isEditable}
      title={isEditable ? "Edit links always allow downloads" : undefined}
      onChange={onChange}
    />
  );
}
