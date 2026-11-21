// @vitest-environment jsdom
//
// Browser Back while dirty must keep the editor mounted and open the leave
// dialog. The guard has to move the location *through the router*: the
// router is already on the destination by the time `popstate` fires, so a
// raw `history.pushState` leaves it desynced (editor unmounts, dialog never
// shows) and breaks the back stack.
//
// Written without JSX because `vitest.config.ts` only includes `.test.ts`.

import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useLeaveConfirm } from "./useLeaveConfirm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Editor({ dirty, saveOk }: { dirty: boolean; saveOk: boolean }) {
  const { pathname } = useLocation();
  const leave = useLeaveConfirm({
    isDirty: dirty,
    saveNow: async () => saveOk,
    discardPendingLocalWork: () => {},
  });
  return h(
    "div",
    { "data-testid": "editor" },
    h("span", { "data-testid": "path" }, pathname),
    h("span", { "data-testid": "open" }, leave.open ? "open" : "closed"),
    h("button", { type: "button", onClick: () => void leave.saveAndLeave() }, "save-and-leave"),
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

/** jsdom performs the history traversal on its own task, then fires popstate. */
async function pressBack() {
  await act(async () => {
    window.history.back();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

const openState = () => document.querySelector('[data-testid="open"]')?.textContent;

async function openEditor() {
  await click("open editor");
  expect(window.location.pathname).toBe("/editor");
}

describe("useLeaveConfirm browser Back", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/other");
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = "";
  });

  it("keeps the dirty editor mounted and opens the dialog", async () => {
    await mount(true);
    await openEditor();

    await pressBack();

    expect(window.location.pathname).toBe("/editor");
    expect(document.querySelector('[data-testid="editor"]')).not.toBeNull();
    expect(openState()).toBe("open");
  });

  it("lets a clean editor navigate away", async () => {
    await mount(false);
    await openEditor();

    await pressBack();

    expect(window.location.pathname).toBe("/other");
    expect(document.querySelector('[data-testid="other"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="editor"]')).toBeNull();
  });

  it("keeps the dialog open when the save fails", async () => {
    await mount(true, false);
    await openEditor();

    await pressBack();
    expect(openState()).toBe("open");

    await click("save-and-leave");

    expect(openState()).toBe("open");
    expect(window.location.pathname).toBe("/editor");
    expect(document.querySelector('[data-testid="editor"]')).not.toBeNull();
  });
});
