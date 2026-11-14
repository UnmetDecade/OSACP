import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSideload, deleteSideload } from "../api";
import { I18nProvider } from "../i18n";
import type { Host, Sideload } from "../types";
import {
  CreateSideloadModal,
  SideloadDetailModal,
  sideloadState,
} from "./Sideload";

vi.mock("../api", () => ({
  createSideload: vi.fn(),
  deleteSideload: vi.fn(),
}));

const NOW = Date.parse("2026-01-01T12:00:00Z");

function sideload(overrides: Partial<Sideload> = {}): Sideload {
  return {
    sideload_id: "sdl-1",
    host_id: "h1",
    name: "CI runner",
    token_hint: "abcd",
    scopes: ["tasks:read", "tasks:write"],
    created_by: "ops",
    created_at: "2026-01-01T00:00:00Z",
    expires_at: null,
    last_seen_at: null,
    last_ip: null,
    revoked_at: null,
    ...overrides,
  };
}

const host: Host = {
  id: "h1",
  name: "devbox",
  os: "Linux",
  arch: "x86_64",
  runtime_version: "4.5.1",
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
};

function renderModal(ui: ReactNode) {
  return render(<I18nProvider>{ui}</I18nProvider>);
}

beforeEach(() => {
  localStorage.setItem("app-lang", "en");
  vi.mocked(createSideload).mockReset();
  vi.mocked(deleteSideload).mockReset();
});

afterEach(() => {
  localStorage.clear();
});

describe("sideloadState", () => {
  it("lets revocation and expiry win over recent traffic", () => {
    expect(sideloadState(sideload({ revoked_at: "2026-01-01T00:00:00Z" }), NOW)).toBe(
      "expired",
    );
    expect(
      sideloadState(
        sideload({
          expires_at: "2026-01-01T11:59:00Z",
          last_seen_at: "2026-01-01T11:59:30Z",
        }),
        NOW,
      ),
    ).toBe("expired");
  });

  it("reports online only for traffic within the last two minutes", () => {
    expect(
      sideloadState(sideload({ last_seen_at: "2026-01-01T11:59:00Z" }), NOW),
    ).toBe("online");
    expect(
      sideloadState(sideload({ last_seen_at: "2026-01-01T11:57:00Z" }), NOW),
    ).toBe("offline");
    expect(sideloadState(sideload(), NOW)).toBe("offline");
  });
});

describe("CreateSideloadModal", () => {
  it("creates a token with the selected scopes and shows it once", async () => {
    vi.mocked(createSideload).mockResolvedValue({
      sideload: sideload(),
      token: "sdl_secret_value",
      base_url: "https://pcs.example",
    });
    const onCreated = vi.fn(async () => undefined);
    const onClose = vi.fn();
    renderModal(
      <CreateSideloadModal host={host} onClose={onClose} onCreated={onCreated} />,
    );

    const submit = screen.getByRole("button", { name: "Create token" });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("Who is using this token"), {
      target: { value: "CI" },
    });
    expect(submit).toBeEnabled();

    fireEvent.click(submit);

    await waitFor(() => expect(createSideload).toHaveBeenCalledTimes(1));
    expect(createSideload).toHaveBeenCalledWith({
      hostId: "h1",
      name: "CI",
      scopes: ["tasks:read", "tasks:write", "builders:read"],
      expiresInDays: 30,
    });
    expect(onCreated).toHaveBeenCalledTimes(1);

    expect(await screen.findByText("Sideload created")).toBeInTheDocument();
    expect(screen.getByText("sdl_secret_value")).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/pcs\.example/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps console:run coupled to tasks:write", async () => {
    renderModal(
      <CreateSideloadModal host={host} onClose={vi.fn()} onCreated={vi.fn(async () => undefined)} />,
    );

    const [read, write, , , run] = screen.getAllByRole("checkbox");
    expect(read).toBeChecked();
    expect(write).toBeChecked();
    expect(run).not.toBeChecked();

    fireEvent.click(run);
    expect(write).toBeChecked();
    expect(run).toBeChecked();

    fireEvent.click(write);
    expect(write).not.toBeChecked();
    expect(run).not.toBeChecked();

    fireEvent.click(read);
    expect(read).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Create token" })).toBeDisabled();
  });

  it("omits an empty expiry", async () => {
    vi.mocked(createSideload).mockResolvedValue({
      sideload: sideload(),
      token: "sdl_x",
      base_url: "https://pcs.example",
    });
    renderModal(
      <CreateSideloadModal host={host} onClose={vi.fn()} onCreated={vi.fn(async () => undefined)} />,
    );

    fireEvent.change(screen.getByPlaceholderText("Who is using this token"), {
      target: { value: "CI" },
    });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));

    await waitFor(() => expect(createSideload).toHaveBeenCalledTimes(1));
    const input = vi.mocked(createSideload).mock.calls[0][0];
    expect(input.name).toBe("CI");
    expect(input).not.toHaveProperty("expiresInDays");
  });

  it("surfaces a creation error and re-enables the form", async () => {
    vi.mocked(createSideload).mockRejectedValue(new Error("quota exceeded"));
    renderModal(
      <CreateSideloadModal host={host} onClose={vi.fn()} onCreated={vi.fn(async () => undefined)} />,
    );

    fireEvent.change(screen.getByPlaceholderText("Who is using this token"), {
      target: { value: "CI" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));

    expect(await screen.findByText("quota exceeded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create token" })).toBeEnabled();
  });
});

describe("SideloadDetailModal", () => {
  it("shows token metadata and requires confirmation before deleting", async () => {
    vi.mocked(deleteSideload).mockResolvedValue({
      sideload: { sideload_id: "sdl-1", host_id: "h1", name: "CI runner" },
    });
    const onDeleted = vi.fn(async () => undefined);
    const onClose = vi.fn();
    renderModal(
      <SideloadDetailModal
        sideload={sideload({
          last_seen_at: new Date(Date.now() - 30_000).toISOString(),
          last_ip: "10.0.0.9",
        })}
        hostName="devbox"
        onClose={onClose}
        onDeleted={onDeleted}
      />,
    );

    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText(/10\.0\.0\.9/)).toBeInTheDocument();
    expect(screen.getByText("Read tasks")).toBeInTheDocument();
    expect(screen.getByText("Write tasks")).toBeInTheDocument();
    expect(deleteSideload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete sideload" }));
    expect(
      screen.getByText(/The token stops working immediately after deletion/),
    ).toBeInTheDocument();
    expect(deleteSideload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    await waitFor(() => expect(deleteSideload).toHaveBeenCalledWith("sdl-1"));
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open and reports a delete failure", async () => {
    vi.mocked(deleteSideload).mockRejectedValue(new Error("already revoked"));
    const onClose = vi.fn();
    renderModal(
      <SideloadDetailModal
        sideload={sideload()}
        hostName="devbox"
        onClose={onClose}
        onDeleted={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete sideload" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    expect(await screen.findByText("already revoked")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Confirm delete" })).toBeEnabled();
  });
});
