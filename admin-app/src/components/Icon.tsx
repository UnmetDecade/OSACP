const PATHS: Record<string, string> = {
  office: "M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5M9 21v-6h6v6",
  chat: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l2-3.2A8.5 8.5 0 1 1 21 11.5Z",
  terminal: "M4 5h16v14H4zM7.5 10l2.5 2.5-2.5 2.5M12.5 15H16",
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  server: "M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01",
  box: "M12 3 21 8v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8",
  layers: "m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5",
  workflow: "M5 4h5v5H5zM14 15h5v5h-5zM7.5 9v3a3 3 0 0 0 3 3H14",
  agent: "M12 3v3M6 6h12a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM9 11h.01M15 11h.01M9 15h6",
  api: "M9 7H7a5 5 0 0 0 0 10h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8",
  tasks: "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2",
  shield: "M12 3 20 6v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  logs: "M4 5h16M4 10h10M4 15h16M4 20h8",
  code: "m8 8-4 4 4 4M16 8l4 4-4 4M13 5l-2 14",
  plus: "M12 5v14M5 12h14",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM16 16l4.5 4.5",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19",
  moon: "M20 14.5A8 8 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21M12 3C9.5 5.6 8.2 8.6 8.2 12S9.5 18.4 12 21",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z",
  send: "M12 19V5M5 12l7-7 7 7",
  back: "M15 5l-7 7 7 7",
  arrow: "M5 12h14M14 7l5 5-5 5",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
  chevron: "m8 10 4 4 4-4",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  close: "M6 6l12 12M18 6 6 18",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  clock: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l3 2",
  alert: "M12 4 2.5 20h19zM12 10v4M12 17h.01",
  check: "m5 12 4 4L19 6",
  play: "M8 5v14l11-7z",
  stop: "M7 7h10v10H7z",
  copy: "M9 9h10v12H9zM5 15H3V3h12v2",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5",
  bot: "M12 3v3M7 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM9 11h.01M15 11h.01M9 15h6",
  unlink: "m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71M8 2v3M2 8h3M16 22v-3M22 16h-3",
};

export function Icon({
  name,
  size = 16,
  className = "",
}: {
  name: keyof typeof PATHS | string;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name] ?? PATHS.dots} />
    </svg>
  );
}
