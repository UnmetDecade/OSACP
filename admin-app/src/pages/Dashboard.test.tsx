import { render, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../store";
import type { Host } from "../types";
import { I18nProvider } from "../i18n";
import { HostScopeProvider } from "../host-context";
import { useLive } from "../live/context";
import { Dashboard } from "./Dashboard";

vi.mock("../live/context", () => ({ useLive: vi.fn() }));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function host(overrides: Partial<Host> = {}): Host {
  return {
    id: "h1",
    name: "devbox",
    os: "Linux",
    arch: "x86_64",
    runtime_version: "4.6.0",
    state: "ONLINE",
    cpu: 10,
    mem: 20,
    disk: 30,
    cpu_total: 8,
    mem_total_mb: 32768,
    mem_available_mb: 16384,
    labels: {},
    capabilities: [],
    registered_at: "2026-01-01T00:00:00Z",
    maintaining: false,
    role_mode: "containers",
    ...overrides,
  };
}

function renderDashboard(h: Host) {
  db.hosts = [h];
  sessionStorage.setItem("current-host", h.id);
  return render(
    <MemoryRouter>
      <I18nProvider>
        <HostScopeProvider>
          <Dashboard />
        </HostScopeProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

// The checklist step as a whole: title, description, hint and action live in the same row. The studio
// behind it repeats some labels, so find the row by its title inside the checklist specifically.
function stepFor(title: string): HTMLElement {
  const titles = document.querySelectorAll(".guide-list .guide-item b");
  const row = [...titles].find((el) => el.textContent === title)?.closest(".guide-item");
  if (!(row instanceof HTMLElement)) throw new Error(`no checklist row for ${title}`);
  return row;
}

beforeEach(() => {
  localStorage.setItem("app-lang", "en");
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.mocked(useLive).mockReturnValue({
    connected: true,
    syncing: false,
    version: 0,
    error: "",
    lastSync: "2026-01-01T00:00:00Z",
    summary: null,
    refresh: vi.fn(),
  });
});

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  db.hosts = [];
  db.instances = [];
  vi.unstubAllGlobals();
});

describe("Dashboard getting-started checklist", () => {
  it("offers the deploy action for a container host", () => {
    renderDashboard(host());
    const step = stepFor("Deploy builder");
    expect(within(step).getByRole("button", { name: "Deploy now →" })).toBeTruthy();
    expect(within(step).queryByText("Waiting for a scheduler")).toBeNull();
  });

  it("waits for a scheduler instead of offering a builder deploy on a bare-metal builder host", () => {
    renderDashboard(host({ role_mode: "builder" }));
    const step = stepFor("Deploy builder");
    expect(within(step).getByText("Waiting for a scheduler")).toBeTruthy();
    expect(within(step).queryByRole("button", { name: "Deploy now →" })).toBeNull();
  });
});
