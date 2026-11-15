import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { db } from "../store";
import { useLive } from "../live/context";
import { HostsPage } from "./Hosts";

vi.mock("../live/context", () => ({ useLive: vi.fn() }));

function renderHosts(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <I18nProvider>
        <HostsPage />
      </I18nProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.setItem("app-lang", "en");
  db.hosts.length = 0;
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

describe("HostsPage add-host dialog", () => {
  it("opens the dialog when the studio deep-links with ?add=1", () => {
    renderHosts("/hosts?add=1");
    // The page button and the modal title share the same label.
    expect(screen.getAllByText("Add host")).toHaveLength(2);
    expect(screen.getByText("Enrollment")).toBeTruthy();
  });

  it("stays closed on a plain visit", () => {
    renderHosts("/hosts");
    expect(screen.getAllByText("Add host")).toHaveLength(1);
    expect(screen.queryByText("Enrollment")).toBeNull();
  });
});
