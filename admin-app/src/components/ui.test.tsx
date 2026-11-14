import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardTitle,
  Digest,
  Dot,
  Empty,
  Field,
  KeyVal,
  Meter,
  Modal,
  PageHead,
  Stat,
  Switch,
  Tag,
} from "./ui";

beforeEach(() => {
  localStorage.setItem("app-lang", "en");
});

describe("layout primitives", () => {
  it("renders a page head with metadata and actions", () => {
    render(
      <PageHead
        title="Hosts"
        meta={<span>3 online</span>}
        actions={<button type="button">Add</button>}
      />,
    );
    expect(screen.getByRole("heading", { name: "Hosts" })).toBeInTheDocument();
    expect(screen.getByText("3 online")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  it("renders card variants and an optional subtitle", () => {
    const { container } = render(
      <>
        <Card className="extra" flush style={{ color: "red" }}>
          plain
        </Card>
        <CardTitle extra={<span>right</span>} sub="subtitle">
          Title
        </CardTitle>
      </>,
    );
    const card = container.querySelector("section.card")!;
    expect(card.className).toContain("card-flush");
    expect(card.className).toContain("extra");
    expect(card).toHaveStyle({ color: "rgb(255, 0, 0)" });
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getByText("subtitle")).toBeInTheDocument();
    expect(screen.getByText("right")).toBeInTheDocument();
  });
});

describe("status primitives", () => {
  it("translates known badges and falls back to the raw value", () => {
    const { container } = render(
      <>
        <Badge value="ONLINE" />
        <Badge value="CUSTOM" />
        <Badge value="FAILED" text="boom" />
      </>,
    );
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText("CUSTOM")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(container.querySelectorAll(".status-ok")).toHaveLength(1);
    expect(container.querySelectorAll(".status-muted")).toHaveLength(1);
    expect(container.querySelectorAll(".status-bad")).toHaveLength(1);
  });

  it("renders tags, dots and empty states", () => {
    const { container } = render(
      <>
        <Tag tone="warn" title="careful">
          warn
        </Tag>
        <Dot tone="bad" />
        <Empty text="nothing here" />
      </>,
    );
    const tag = screen.getByTitle("careful");
    expect(tag).toHaveClass("tag", "tag-warn");
    expect(container.querySelector(".dot-bad")).toBeInTheDocument();
    expect(screen.getByText("nothing here")).toHaveClass("empty");
  });
});

describe("controls", () => {
  it("forwards button behavior and variants", () => {
    const onClick = vi.fn();
    render(
      <>
        <Button onClick={onClick} variant="primary" size="sm" title="go">
          Run
        </Button>
        <Button disabled>Stop</Button>
        <Button type="submit">Save</Button>
      </>,
    );

    const run = screen.getByRole("button", { name: "Run" });
    expect(run).toHaveClass("btn", "btn-primary", "btn-sm");
    expect(run).toHaveAttribute("title", "go");
    fireEvent.click(run);
    expect(onClick).toHaveBeenCalledTimes(1);

    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop).toBeDisabled();
    expect(stop).toHaveClass("btn-default");

    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "submit");
  });

  it("renders a field label and hint, and a switch that reports changes", () => {
    const onChange = vi.fn();
    render(
      <>
        <Field label="Name" hint="unique per host">
          <input />
        </Field>
        <Switch checked onChange={onChange} label="Enabled" />
        <Switch checked={false} onChange={onChange} disabled label="Disabled" />
      </>,
    );
    expect(screen.getByText("Name")).toHaveClass("field-label");
    expect(screen.getByText("unique per host")).toHaveClass("field-hint");

    fireEvent.click(screen.getByRole("checkbox", { name: "Enabled" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("checkbox", { name: "Disabled" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Disabled" }).closest("label")).toHaveClass(
      "is-disabled",
    );
  });
});

describe("data primitives", () => {
  it("draws meter levels and caps the bar width", () => {
    const { container } = render(
      <>
        <Meter value={40} />
        <Meter value={80} />
        <Meter value={120} />
      </>,
    );
    const meters = container.querySelectorAll(".meter");
    expect(meters[0]).toHaveAttribute("title", "40%");
    expect(meters[0].querySelector(".meter-ok")).toBeInTheDocument();
    expect(meters[1].querySelector(".meter-warn")).toBeInTheDocument();
    expect(meters[2].querySelector(".meter-bad")).toBeInTheDocument();
    expect(meters[2].querySelector<HTMLElement>(".meter-fill")!.style.width).toBe("100%");
  });

  it("renders stats, key/value rows, digests and callouts", () => {
    const { container } = render(
      <>
        <Stat label="Tasks" value={12} tone="warn" />
        <KeyVal label="Host">
          <span>devbox</span>
        </KeyVal>
        <Digest value="sha256:abc" />
        <Callout tone="bad">failed</Callout>
      </>,
    );
    expect(screen.getByText("Tasks").parentElement?.querySelector("strong")).toHaveClass(
      "text-warn",
    );
    expect(screen.getByText("Host").parentElement).toHaveClass("kv");
    expect(container.querySelector(".kv b")?.textContent).toBe("devbox");
    expect(screen.getByText("sha256:abc")).toHaveClass("digest");
    expect(screen.getByText("sha256:abc")).toHaveAttribute("title", "sha256:abc");
    expect(container.querySelector(".callout-bad")).toBeInTheDocument();
  });
});

describe("Modal", () => {
  it("renders nothing while closed", () => {
    const { container } = render(
      <Modal open={false} title="Hidden" onClose={vi.fn()}>
        body
      </Modal>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("closes from the button and the mask but not from inside the dialog", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal open title="Details" onClose={onClose} footer={<span>footer</span>}>
        <p>body</p>
      </Modal>,
    );

    expect(screen.getByRole("heading", { name: "Details" })).toBeInTheDocument();
    expect(screen.getByText("footer").parentElement).toHaveClass("modal-foot");
    fireEvent.mouseDown(container.querySelector(".modal")!);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(container.querySelector(".modal-mask")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
