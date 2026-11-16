import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../store";
import type { Host } from "../types";
import { I18nProvider } from "../i18n";
import { StudioScene } from "./StudioScene";

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

function renderScene(h: Host) {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <StudioScene
          host={h}
          sideloads={[]}
          onAdd={vi.fn()}
          onAddSideload={vi.fn()}
          onOpenSideload={vi.fn()}
          onDeployScheduler={vi.fn()}
          onDeployBuilder={vi.fn()}
        />
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.setItem("app-lang", "en");
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  localStorage.clear();
  db.instances = [];
  vi.unstubAllGlobals();
});

describe("StudioScene builder entry", () => {
  it("offers the create card on a host with no roles yet", () => {
    renderScene(host());
    // Scheduler and builder both offer a card before anything is deployed.
    expect(screen.getAllByText("Not deployed")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Deploy builder" })).toBeTruthy();
  });

  it("shows a waiting builder card once the host is a bare-metal builder with no instance", () => {
    renderScene(host({ role_mode: "builder" }));
    expect(screen.getByText("Waiting for a scheduler")).toBeTruthy();
    // The role switch already happened; repeating the deploy action would do nothing.
    expect(screen.queryByRole("button", { name: "Deploy builder" })).toBeNull();
    expect(screen.queryByText("Not deployed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Deploy scheduler" })).toBeNull();
  });
});
