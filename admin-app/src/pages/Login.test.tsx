import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { useAuth } from "../auth";
import { LoginPage } from "./Login";

vi.mock("../auth", () => ({ useAuth: vi.fn() }));

const login = vi.fn();

beforeEach(() => {
  localStorage.setItem("app-lang", "en");
  login.mockReset();
  vi.mocked(useAuth).mockReturnValue({
    status: "anonymous",
    account: null,
    scopes: [],
    login,
    register: vi.fn(),
    logout: vi.fn(),
    hasScope: () => false,
    refresh: vi.fn(),
  });
});

function renderLogin() {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <LoginPage />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("LoginPage", () => {
  it("submits the credentials and keeps the button disabled until both fields are filled", async () => {
    login.mockResolvedValue(undefined);
    renderLogin();
    const submit = screen.getByRole("button", { name: "Sign in" });
    expect(submit).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(submit);

    await waitFor(() => expect(login).toHaveBeenCalledWith("alice", "secret"));
  });

  it("shows the server error when sign-in fails", async () => {
    login.mockRejectedValue(new Error("INVALID_CREDENTIALS: invalid username or password"));
    renderLogin();
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("INVALID_CREDENTIALS: invalid username or password")).toBeTruthy();
  });
});
