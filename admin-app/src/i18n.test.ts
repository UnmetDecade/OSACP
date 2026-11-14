import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentLang,
  detectLang,
  I18nProvider,
  storedLang,
  t,
  useI18n,
} from "./i18n";

describe("detectLang", () => {
  it("uses Chinese for every zh variant", () => {
    expect(detectLang({ language: "zh-CN", languages: ["zh-CN"] })).toBe("zh");
    expect(detectLang({ language: "zh-TW", languages: ["zh-TW"] })).toBe("zh");
    expect(detectLang({ language: "zh", languages: ["zh"] })).toBe("zh");
  });

  it("uses English for any non-Chinese browser language", () => {
    expect(detectLang({ language: "en-US", languages: ["en-US"] })).toBe("en");
    expect(detectLang({ language: "ja-JP", languages: ["ja-JP"] })).toBe("en");
    expect(detectLang({ language: "de-DE", languages: ["de-DE", "en"] })).toBe("en");
  });

  it("checks the full languages list, not only the primary language", () => {
    expect(detectLang({ language: "en-US", languages: ["en-US", "zh-CN"] })).toBe("zh");
  });

  it("falls back to English when no navigator is available", () => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: undefined });
    try {
      expect(detectLang()).toBe("en");
    } finally {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: original });
    }
  });
});

describe("storedLang", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("prefers a saved explicit choice", () => {
    localStorage.setItem("app-lang", "zh");
    expect(storedLang()).toBe("zh");
    localStorage.setItem("app-lang", "en");
    expect(storedLang()).toBe("en");
  });

  it("follows the browser language when nothing is saved", () => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { language: "zh-CN", languages: ["zh-CN"] },
    });
    try {
      expect(storedLang()).toBe("zh");
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { language: "fr-FR", languages: ["fr-FR"] },
      });
      expect(storedLang()).toBe("en");
    } finally {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: original });
    }
  });

  it("ignores an unknown stored value", () => {
    localStorage.setItem("app-lang", "klingon");
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { language: "zh-CN", languages: ["zh-CN"] },
    });
    try {
      expect(storedLang()).toBe("zh");
    } finally {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: original });
    }
  });
});

describe("t", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("switches copy when the language changes", () => {
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });
    act(() => result.current.setLang("en"));
    expect(t("任务")).toBe("Tasks");
    act(() => result.current.setLang("zh"));
    expect(t("任务")).toBe("任务");
  });

  it("keeps the Chinese source when a translation is missing", () => {
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });
    act(() => result.current.setLang("en"));
    expect(t("这个键还没有英文翻译")).toBe("这个键还没有英文翻译");
  });

  it("substitutes placeholders", () => {
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });
    act(() => result.current.setLang("en"));
    expect(t("删除 {name}？容器与数据卷都会被删除。", { name: "builder-01" })).toBe(
      "Delete builder-01? The container and its volumes will be deleted.",
    );
  });

  it("updates currentLang and the document language", () => {
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });
    act(() => result.current.setLang("en"));
    expect(currentLang()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    act(() => result.current.setLang("zh"));
    expect(document.documentElement.lang).toBe("zh-CN");
  });
});
