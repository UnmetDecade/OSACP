import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { submitBuild } from "../api";
import { useHostScope } from "../host-context";
import { I18nProvider } from "../i18n";
import { useLive } from "../live/context";
import { db } from "../store";
import type { Host, Instance } from "../types";
import { CreateTaskModal, attachmentPreviewSrc } from "./CreateTask";

vi.mock("../api", () => ({ submitBuild: vi.fn() }));
vi.mock("../live/context", () => ({ useLive: vi.fn() }));
vi.mock("../host-context", () => ({ useHostScope: vi.fn() }));

const host: Host = {
  id: "h1",
  name: "devbox",
  os: "Linux",
  arch: "x86_64",
  runtime_version: "4.5.1",
  state: "ONLINE",
  cpu: 0,
  mem: 0,
  disk: 0,
  cpu_total: 8,
  mem_total_mb: 32768,
  mem_available_mb: 16384,
  labels: {},
  capabilities: [],
  registered_at: "2026-01-01T00:00:00Z",
  maintaining: false,
};

function scheduler(state: Instance["state"] = "ONLINE"): Instance {
  return {
    key: "h1/root",
    id: "root",
    deployment_id: "dep-root",
    name: "root scheduler",
    role: "scheduler",
    host_id: "h1",
    agent_profile_id: "",
    api_profile_ids: [],
    task_types: ["task.chat.scheduler"],
    resource_profile: "4C / 6144MiB",
    cpu_limit: 4,
    mem_limit_mb: 6144,
    disk_gb: 64,
    state,
    config_version: 1,
    last_heartbeat: "2026-01-01T00:00:00Z",
    image: "",
    scheduler_role: "root",
    created_at: "2026-01-01T00:00:00Z",
  };
}

const refresh = vi.fn(async () => undefined);

function renderModal(onClose = vi.fn()) {
  return {
    onClose,
    ...render(
      <MemoryRouter>
        <I18nProvider>
          <CreateTaskModal open onClose={onClose} />
        </I18nProvider>
      </MemoryRouter>,
    ),
  };
}

beforeEach(() => {
  localStorage.setItem("app-lang", "en");
  db.instances.length = 0;
  db.instances.push(scheduler());
  refresh.mockClear();
  vi.mocked(useLive).mockReturnValue({
    connected: true,
    syncing: false,
    version: 0,
    error: "",
    lastSync: "2026-01-01T00:00:00Z",
    summary: null,
    refresh,
  });
  vi.mocked(useHostScope).mockReturnValue({ hosts: [host], host, setHostId: vi.fn() });
  vi.mocked(submitBuild).mockReset();
});

afterEach(() => {
  localStorage.clear();
});

describe("attachmentPreviewSrc", () => {
  it("renders a data URL only for images with valid base64 payloads", () => {
    expect(attachmentPreviewSrc("image/png", "iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(attachmentPreviewSrc("image/webp", "AAAA")).toBe("data:image/webp;base64,AAAA");
  });

  it("rejects non-image media types and malformed payloads", () => {
    expect(attachmentPreviewSrc("image/svg+xml", "PHN2Zz4=")).toBeNull();
    expect(attachmentPreviewSrc("text/html", "PGgxPg==")).toBeNull();
    expect(attachmentPreviewSrc("image/png", "not base64!")).toBeNull();
    expect(attachmentPreviewSrc("image/png", "AAAA\nBBBB")).toBeNull();
    expect(attachmentPreviewSrc("image/png", "AA=AAA")).toBeNull();
  });
});

describe("CreateTaskModal", () => {
  it("submits the description, priority, autonomy and owning scheduler", async () => {
    vi.mocked(submitBuild).mockResolvedValue("task-1");
    const { onClose, container } = renderModal();

    fireEvent.change(screen.getByPlaceholderText("e.g. Pixel-art web game demo"), {
      target: { value: "Demo" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("e.g. Write Hello World in C++, compile and run it."),
      { target: { value: "Build the demo\nwith tests" } },
    );
    // The Field label wraps the segmented control, so query the visible segment text and walk to its button.
    fireEvent.click(screen.getByText("Highest").closest("button")!);
    fireEvent.click(
      screen.getByText("Read-only, asks questions").closest("button")!,
    );

    fireEvent.click(screen.getByRole("button", { name: "Queue task" }));

    await waitFor(() => expect(submitBuild).toHaveBeenCalledTimes(1));
    expect(submitBuild).toHaveBeenCalledWith(
      {
        title: "Demo",
        description: "Build the demo\nwith tests",
        priority: 0,
        approval_mode: "ask",
        scheduler_deployment_id: "dep-root",
        attachments: [],
      },
      expect.any(Function),
    );
    // The refresh callback only runs when the live connection is up.
    await vi.mocked(submitBuild).mock.calls[0][1]();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(container.querySelector("input[type=file]")).toBeInTheDocument();
  });

  it("rejects an empty description and shows the reason", () => {
    renderModal();

    fireEvent.click(screen.getByRole("button", { name: "Queue task" }));

    expect(
      screen.getByText("Describe the task or add an attachment first"),
    ).toBeInTheDocument();
    expect(submitBuild).not.toHaveBeenCalled();
  });

  it("uploads a picked file and uses its name when the description is empty", async () => {
    vi.mocked(submitBuild).mockResolvedValue("task-2");
    const { container } = renderModal();

    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    // jsdom does not always implement Blob.arrayBuffer; the dialog only needs the bytes.
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("hello").buffer,
    });
    const picker = container.querySelector<HTMLInputElement>("input[type=file]")!;
    fireEvent.change(picker, { target: { files: [file] } });

    expect(await screen.findByText("note.txt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Queue task" }));

    await waitFor(() => expect(submitBuild).toHaveBeenCalledTimes(1));
    const input = vi.mocked(submitBuild).mock.calls[0][0];
    expect(input.description).toBe("note.txt");
    expect(input.attachments).toEqual([
      {
        name: "note.txt",
        media_type: "text/plain",
        size: 5,
        data_base64: "aGVsbG8=",
      },
    ]);

    fireEvent.click(screen.getByTitle("Remove"));
    expect(screen.queryByText("note.txt")).not.toBeInTheDocument();
  });

  it("reports submit failures without closing the dialog", async () => {
    vi.mocked(submitBuild).mockRejectedValue(new Error("scheduler down"));
    const { onClose } = renderModal();

    fireEvent.change(
      screen.getByPlaceholderText("e.g. Write Hello World in C++, compile and run it."),
      { target: { value: "Build" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Queue task" }));

    expect(await screen.findByText("scheduler down")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Queue task" })).toBeEnabled();
  });

  it("disables submission without an online root scheduler", () => {
    db.instances[0] = scheduler("OFFLINE");
    renderModal();

    expect(screen.getByRole("button", { name: "Queue task" })).toBeDisabled();
  });

  it("points to the studio when this host has no scheduler", () => {
    db.instances.length = 0;
    renderModal();

    expect(screen.getByRole("button", { name: "Queue task" })).toBeDisabled();
    expect(
      screen.getByText(/This host has no root scheduler yet/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Deploy a scheduler in the AI Agent Studio" }),
    ).toHaveAttribute("href", "/?add=scheduler");
  });
});
