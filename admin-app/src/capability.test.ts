import { describe, expect, it } from "vitest";
import { capabilityFromResources, computeCapabilityScore } from "./capability";

describe("computeCapabilityScore", () => {
  it("returns 0 when no capability detail is available", () => {
    expect(computeCapabilityScore(null)).toBe(0);
    expect(computeCapabilityScore(undefined)).toBe(0);
  });

  it("reaches 1000 when every dimension is at or above its ceiling", () => {
    expect(
      computeCapabilityScore({
        cores: 8,
        freq_ghz: 4,
        mem_gb: 32,
        disk_gb: 256,
        model: 10,
        api: 10,
      }),
    ).toBe(1000);
  });

  it("caps oversized machines at 1000", () => {
    expect(
      computeCapabilityScore({
        cores: 256,
        freq_ghz: 8,
        mem_gb: 1024,
        disk_gb: 4096,
        model: 100,
        api: 100,
      }),
    ).toBe(1000);
  });

  it("computes the weighted score and rounds to an integer", () => {
    expect(
      computeCapabilityScore({
        cores: 4,
        freq_ghz: 2,
        mem_gb: 16,
        disk_gb: 128,
        model: 5,
        api: 5,
      }),
    ).toBe(500);
  });

  it("treats missing, non-finite and negative dimensions as zero", () => {
    expect(
      computeCapabilityScore({
        cores: Number.NaN,
        freq_ghz: -1,
        mem_gb: undefined as unknown as number,
        disk_gb: 0,
        model: 0,
        api: 0,
      }),
    ).toBe(0);
  });
});

describe("capabilityFromResources", () => {
  it("converts memory from MiB to GiB and keeps the supplied tier", () => {
    expect(capabilityFromResources({ cpus: 8, mem_mb: 32768, disk_gb: 256 })).toEqual({
      cores: 8,
      mem_gb: 32,
      disk_gb: 256,
    });
  });

  it("keeps only positive, finite optional dimensions", () => {
    expect(
      capabilityFromResources({
        cpus: 4,
        mem_mb: 8192,
        disk_gb: 64,
        freq_ghz: 3.2,
        model: 0,
        api: Number.NaN,
      }),
    ).toEqual({
      cores: 4,
      mem_gb: 8,
      disk_gb: 64,
      freq_ghz: 3.2,
    });
  });
});
