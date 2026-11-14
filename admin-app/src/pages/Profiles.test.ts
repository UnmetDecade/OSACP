import { describe, expect, it } from "vitest";
import { apiProviderOf } from "./Profiles";

describe("apiProviderOf", () => {
  it("matches the exact provider hosts", () => {
    expect(apiProviderOf("https://api.deepseek.com")).toBe("deepseek");
    expect(apiProviderOf("https://api.anthropic.com/v1")).toBe("anthropic");
    expect(apiProviderOf("https://api.openai.com/v1")).toBe("openai");
    expect(apiProviderOf("api.deepseek.com")).toBe("deepseek");
  });

  it("compares hostnames, not substrings", () => {
    expect(apiProviderOf("https://api.deepseek.com.evil.example")).toBe("custom");
    expect(apiProviderOf("https://notapi.anthropic.com.attacker.test")).toBe("custom");
    expect(apiProviderOf("https://evil.example/?next=api.openai.com")).toBe("custom");
    expect(apiProviderOf("https://api.deepseek.com@evil.example")).toBe("custom");
  });

  it("falls back to custom for unparsable input", () => {
    expect(apiProviderOf("")).toBe("custom");
    expect(apiProviderOf("http://[::1")).toBe("custom");
  });
});
