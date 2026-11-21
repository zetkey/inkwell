// @vitest-environment jsdom
//
// Browser Back while dirty must keep the editor mounted, open the leave
// dialog AND leave the back stack intact: walking back through the router
// (`navigate(delta)` / `navigate(-delta)`) keeps the destination entry, so
// a Stay does not trap the user and a burst of Backs still reaches the
// newest destination.
//
// Written without JSX because `vitest.config.ts` only includes `.test.ts`.

import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLeaveConfirm } from "./useLeaveConfirm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Editor({ dirty, saveOk }: { dirty: boolean; saveOk: boolean }) {
  const { pathname } = useLocation();
  // Stands in for the save lifecycle: a failed attempt sets its error,
  // which the dialog is expected to surface.
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const leave = useLeaveConfirm({
    isDirty: dirty,
    saveNow: async () => {
      if (saveOk) return true;
      setLifecycleError("Saving failed — the server rejected the update.");
      return false;
    },
    discardPendingLocalWork: () => {},
    errorMessage: lifecycleError,
  });
  return h(
    "div",
    { "data-testid": "editor" },
    h("span", { "data-testid": "path" }, pathname),
    h("span", { "data-testid": "open" }, leave.open ? "open" : "closed"),
    h("span", { "data-testid": "error" }, leave.errorMessage ?? ""),
    h("button", { type: "button", onClick: () => void leave.saveAndLeave() }, "save-and-leave"),
    h("button", { type: "button", onClick: () => leave.cancel() }, "stay"),
    h("button", { type: "button", onClick: () => leave.discard() }, "discard"),
  );
}

function StartPage() {
  const navigate = useNavigate();
  return h(
    "div",
    { "data-testid": "start" },
    h("button", { type: "button", onClick: () => navigate("/other") }, "open other"),
  );
}

function OtherPage() {
  const navigate = useNavigate();
  return h(
    "div",
    { "data-testid": "other" },
    h("button", { type: "button", onClick: () => navigate("/editor") }, "open editor"),
  );
}

let root: Root | null = null;

async function mount(dirty: boolean, saveOk = true) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      h(
        BrowserRouter,
        null,
        h(
          Routes,
          null,
          h(Route, { path: "/start", element: h(StartPage) }),
          h(Route, { path: "/other", element: h(OtherPage) }),
          h(Route, { path: "/editor", element: h(Editor, { dirty, saveOk }) }),
        ),
      ),
    );
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
}

/** jsdom performs history traversals (and the guard's restore) on tasks,
 *  so wait for the resulting state instead of guessing a delay. */
const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 2_000, interval: 10 });

async function pressBack(times = 1) {
  await act(async () => {
    for (let i = 0; i < times; i++) window.history.back();
  });
}

/** /start -> /other -> /editor, so one Back reaches /other and two reach
 *  /start. */
async function openEditor() {
  await click("open other");
  await click("open editor");
  expect(window.location.pathname).toBe("/editor");
}

const openState = () => document.querySelector('[data-testid="open"]')?.textContent;
const errorText = () => document.querySelector('[data-testid="error"]')?.textContent;
const editorMounted = () => document.querySelector('[data-testid="editor"]') !== null;

describe("useLeaveConfirm browser Back", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/start");
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = "";
  });

  it("keeps the dirty editor mounted, opens the dialog, and keeps the destination after Stay", async () => {
    await mount(true);
    await openEditor();

    await pressBack();
    await waitFor(() => {
      expect(window.location.pathname).toBe("/editor");
      expect(editorMounted()).toBe(true);
      expect(openState()).toBe("open");
    });

    // Stay, then leave for real: the destination entry is still there.
    await click("stay");
    expect(openState()).toBe("closed");

    await pressBack();
    await waitFor(() => expect(openState()).toBe("open"));

    await click("discard");
    await waitFor(() => expect(window.location.pathname).toBe("/other"));
    expect(document.querySelector('[data-testid="other"]')).not.toBeNull();
  });

  it("survives a burst of Back presses without losing the destination", async () => {
    await mount(true);
    await openEditor();

    // Both presses are queued before the guard answers the first one; the
    // restore re-enters the editor entry, so the second traversal lands on
    // the same destination instead of skipping past it.
    await pressBack(2);
    await waitFor(() => {
      expect(window.location.pathname).toBe("/editor");
      expect(openState()).toBe("open");
    });

    await click("discard");
    await waitFor(() => expect(window.location.pathname).toBe("/other"));
    expect(document.querySelector('[data-testid="other"]')).not.toBeNull();
  });

  it("lands on the destination after Save & Leave", async () => {
    await mount(true);
    await openEditor();

    await pressBack();
    await waitFor(() => expect(openState()).toBe("open"));

    await click("save-and-leave");
    await waitFor(() => expect(window.location.pathname).toBe("/other"));

    expect(document.querySelector('[data-testid="other"]')).not.toBeNull();
    expect(editorMounted()).toBe(false);
  });

  it("lets a clean editor navigate away", async () => {
    await mount(false);
    await openEditor();

    await pressBack();
    await waitFor(() => expect(window.location.pathname).toBe("/other"));

    expect(document.querySelector('[data-testid="other"]')).not.toBeNull();
    expect(editorMounted()).toBe(false);
  });

  it("keeps the dialog open and shows why the save failed", async () => {
    await mount(true, false);
    await openEditor();

    await pressBack();
    await waitFor(() => expect(openState()).toBe("open"));

    await click("save-and-leave");
    await waitFor(() => expect(errorText()).toContain("Saving failed"));

    expect(openState()).toBe("open");
    expect(window.location.pathname).toBe("/editor");
    expect(editorMounted()).toBe(true);

    await click("stay");
    expect(openState()).toBe("closed");
    expect(errorText()).toBe("");
  });
});
