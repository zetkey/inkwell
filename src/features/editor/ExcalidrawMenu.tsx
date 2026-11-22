import { MainMenu } from "@excalidraw/excalidraw";
import type { ThemeMode } from "@/lib/theme";

interface ExcalidrawMenuProps {
  variant: "owner" | "shared";
  theme: ThemeMode;
  onSelectTheme: (theme: ThemeMode) => void;
  /** Canvas-mutating items are only offered when the session can save.
   *  The owner editor is always writable; a shared editor passes
   *  `loaded.permission !== "read"`. */
  writable?: boolean;
}

export default function ExcalidrawMenu({
  variant,
  theme,
  onSelectTheme,
  writable = true,
}: ExcalidrawMenuProps) {
  // Owners always have write access; share links only when not read-only.
  const canWrite = variant === "owner" || writable;

  return (
    <MainMenu>
      {/* Canvas-level items. File-level actions (export, rename, download)
          live in the editor header. */}
      <MainMenu.DefaultItems.SearchMenu />
      <MainMenu.DefaultItems.ChangeCanvasBackground />
      {canWrite ? <MainMenu.DefaultItems.ClearCanvas /> : null}
      <MainMenu.Separator />
      <MainMenu.DefaultItems.ToggleTheme allowSystemTheme theme={theme} onSelect={onSelectTheme} />
      <MainMenu.DefaultItems.Help />
    </MainMenu>
  );
}
