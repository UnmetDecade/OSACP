import { beforeEach, describe, expect, it } from "vitest";
import { groupByHost, hostTreeIds } from "./host-tree";
import { db } from "./store";
import type { Host } from "./types";

function host(id: string, name: string, parent: string | null = null): Host {
  return { id, name, parent_host_id: parent } as Host;
}

describe("hostTreeIds", () => {
  beforeEach(() => {
    db.hosts = [
      host("root", "Root"),
      host("child-a", "Child A", "root"),
      host("child-b", "Child B", "root"),
      host("grandchild", "Grandchild", "child-a"),
      host("unrelated", "Unrelated"),
    ];
  });

  it("returns every host folded into the root, recursively", () => {
    expect([...hostTreeIds("root")].sort()).toEqual(
      ["child-a", "child-b", "grandchild", "root"].sort(),
    );
  });

  it("returns just the host when it has no children", () => {
    expect([...hostTreeIds("child-b")]).toEqual(["child-b"]);
  });

  it("returns an empty set without a root", () => {
    expect(hostTreeIds(undefined).size).toBe(0);
  });

  it("does not loop forever on a cycle", () => {
    db.hosts.push(host("root-parent", "Loop", "grandchild"));
    expect(hostTreeIds("root").has("root-parent")).toBe(true);
  });
});

describe("groupByHost", () => {
  beforeEach(() => {
    db.hosts = [host("h1", "Alpha"), host("h2", "Beta")];
  });

  it("groups items, puts the current host first, and sorts the rest by name", () => {
    const groups = groupByHost(
      [
        { host_id: "h2", id: "b" },
        { host_id: "h1", id: "a" },
        { host_id: "h3", id: "c" },
      ],
      "h2",
    );

    expect(groups.map((g) => g.hostId)).toEqual(["h2", "h1", "h3"]);
    expect(groups[0].current).toBe(true);
    expect(groups[0].name).toBe("Beta");
    // A host missing from the local store still gets a usable label.
    expect(groups[2].name).toBe("h3");
    expect(groups[2].current).toBe(false);
  });

  it("keeps every item within its host group", () => {
    const groups = groupByHost(
      [
        { host_id: "h1", id: "a1" },
        { host_id: "h1", id: "a2" },
        { host_id: "h2", id: "b1" },
      ],
      undefined,
    );
    expect(groups.find((g) => g.hostId === "h1")?.items.map((i) => i.id)).toEqual(["a1", "a2"]);
    expect(groups.every((g) => !g.current)).toBe(true);
  });
});
