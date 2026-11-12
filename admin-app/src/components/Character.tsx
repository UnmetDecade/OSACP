import { useId } from "react";
import { CHARACTERS, type CharacterState } from "../characters";
import type { Role } from "../types";

/**
 * Robot avatar: rounded shell + screen face + LED eyes.
 * State only changes the eyes, antenna, arms and badge, never the layout.
 */
export function Character({
  role,
  state = "idle",
  size = 132,
  title,
  flat = false,
}: {
  role: Role;
  state?: CharacterState;
  size?: number;
  title?: string;
  flat?: boolean;
}) {
  const c = CHARACTERS[role];
  const raw = useId();
  const clip = `bot-${raw.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const sleeping = state === "rest" || state === "offline";
  const eyeColor = state === "alert" ? "#ec7070" : state === "offline" ? "#5a6270" : c.led;

  return (
    <svg
      className={`character robot robot-${role} ch-${state}${flat ? " ch-flat" : ""}`}
      width={size}
      height={size}
      viewBox="0 0 96 96"
      role="img"
      aria-label={`${c.name} · ${state}`}
    >
      <title>{title ?? `${c.name}（${c.title}）`}</title>
      <defs>
        <clipPath id={clip}>
          <circle cx="48" cy="48" r="44" />
        </clipPath>
        <linearGradient id={`${clip}-shell`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={c.color} />
          <stop offset="1" stopColor={c.accent} />
        </linearGradient>
      </defs>

      <circle cx="48" cy="48" r="44" fill={c.color} fillOpacity="0.12" />
      {!flat && <circle cx="48" cy="48" r="43.2" fill="none" stroke={c.color} strokeOpacity="0.22" strokeWidth="1.2" />}

      <g clipPath={`url(#${clip})`}>
        <g className="ch-breath">
          {role === "scheduler" && <Halo color={c.led} />}

          {/* Legs */}
          <rect x="35" y="81" width="9" height="11" rx="4" fill={c.accent} />
          <rect x="52" y="81" width="9" height="11" rx="4" fill={c.accent} />

          {/* Body */}
          <rect x="27" y="55" width="42" height="29" rx="13" fill={`url(#${clip}-shell)`} />
          <rect x="38" y="61" width="20" height="14" rx="5" fill={c.screen} fillOpacity="0.86" />
          <circle cx="48" cy="68" r="3.2" fill={c.led} fillOpacity={sleeping ? 0.25 : 0.9} className="robot-core" />

          {/* Arms */}
          <g className="robot-arm robot-arm-left">
            <rect x="19" y="58" width="9" height="19" rx="4.5" fill={c.color} />
            <circle cx="23.5" cy="78" r="4" fill={c.accent} />
          </g>
          <g className="robot-arm robot-arm-right">
            <rect x="68" y="58" width="9" height="19" rx="4.5" fill={c.color} />
            {role === "builder" ? <Wrench color={c.accent} /> : <Clipboard color={c.accent} led={c.led} />}
          </g>

          {role === "scheduler" && <ClockFace color={c.led} screen={c.screen} accent={c.accent} />}

          {/* Antenna */}
          <g className="robot-antenna">
            <path d="M48 22V12" stroke={c.accent} strokeWidth="2" strokeLinecap="round" />
            <circle cx="48" cy="9.5" r="3.2" fill={c.led} fillOpacity={sleeping ? 0.3 : 0.95} />
            {state === "working" && <circle cx="48" cy="9.5" r="6" fill={c.led} fillOpacity="0.18" />}
          </g>

          {/* Head */}
          <rect x="22" y="21" width="52" height="36" rx="13" fill={`url(#${clip}-shell)`} />
          <rect x="28" y="27" width="40" height="24" rx="8" fill={c.screen} />
          <path d="M31 27c0-3 2.5-5.5 5.5-5.5h23c3 0 5.5 2.5 5.5 5.5" fill={c.accent} fillOpacity="0.35" />

          <Eyes state={state} color={eyeColor} />
          <Mouth state={state} color={eyeColor} />

          {role === "builder" && <BuilderCap color={c.color} accent={c.accent} />}
          {role === "scheduler" && <SchedulerBrow color={c.led} />}

          {state === "working" && (
            <g className="robot-particles" fill={c.led} fillOpacity="0.55">
              <rect x="74" y="34" width="3" height="3" rx="1" />
              <rect x="80" y="27" width="2" height="2" rx="1" />
              <rect x="76" y="44" width="2" height="2" rx="1" />
            </g>
          )}
        </g>

        {state === "alert" && (
          <g className="ch-alert-badge">
            <circle cx="76" cy="20" r="8" fill="#c23b3b" />
            <path d="M76 15.5v5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="76" cy="24" r="1" fill="#fff" />
          </g>
        )}
        {state === "rest" && (
          <g className="ch-zzz" fill={c.led} fillOpacity="0.65" fontSize="8" fontWeight="600">
            <text x="72" y="26">z</text>
            <text x="78" y="20">z</text>
          </g>
        )}
      </g>
    </svg>
  );
}

function Eyes({ state, color }: { state: CharacterState; color: string }) {
  if (state === "rest" || state === "offline") {
    return (
      <g stroke={color} strokeWidth="1.8" strokeLinecap="round" fill="none">
        <path d="M38.5 39.5q3 2.4 6 0" />
        <path d="M51.5 39.5q3 2.4 6 0" />
      </g>
    );
  }
  const y = state === "working" ? 40 : 39;
  return (
    <g className="robot-eyes" fill={color}>
      <rect x="36.5" y={y - 3.5} width="7" height="7" rx="3" />
      <rect x="52.5" y={y - 3.5} width="7" height="7" rx="3" />
      <rect x="38" y={y - 2.5} width="2.2" height="2.2" rx="0.8" fill="#fff" fillOpacity="0.75" />
      <rect x="54" y={y - 2.5} width="2.2" height="2.2" rx="0.8" fill="#fff" fillOpacity="0.75" />
    </g>
  );
}

function Mouth({ state, color }: { state: CharacterState; color: string }) {
  if (state === "alert") {
    return <path d="M43 46.5q5-3 10 0" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" />;
  }
  if (state === "rest" || state === "offline") {
    return <path d="M44 46h8" stroke={color} strokeWidth="1.8" strokeLinecap="round" opacity="0.6" />;
  }
  return <path d="M43 44.5q5 3.6 10 0" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" />;
}

function BuilderCap({ color, accent }: { color: string; accent: string }) {
  return (
    <g>
      <path d="M27 24c0-5 4-9 9-9h24c5 0 9 4 9 9z" fill={color} />
      <path d="M24 23h48c1.4 0 2 1.6 1 2.6-.9.9-2.1 1.4-3.6 1.4H26.6c-1.5 0-2.7-.5-3.6-1.4-1-1-.4-2.6 1-2.6Z" fill={accent} fillOpacity="0.55" />
      <path d="M40 18h16" stroke="#fff" strokeOpacity="0.55" strokeWidth="1.4" strokeLinecap="round" />
    </g>
  );
}

function SchedulerBrow({ color }: { color: string }) {
  return (
    <g stroke={color} strokeWidth="1.6" strokeLinecap="round" opacity="0.85">
      <path d="M36 31.5h7" />
      <path d="M53 31.5h7" />
    </g>
  );
}

function Halo({ color }: { color: string }) {
  return (
    <g className="robot-halo">
      <ellipse cx="48" cy="13" rx="15" ry="3.6" fill="none" stroke={color} strokeWidth="1.6" strokeOpacity="0.65" />
      <ellipse cx="48" cy="13" rx="21" ry="5.2" fill="none" stroke={color} strokeWidth="0.8" strokeOpacity="0.22" />
    </g>
  );
}

function Wrench({ color }: { color: string }) {
  return (
    <g className="robot-tool" fill={color}>
      <rect x="70.5" y="76" width="4" height="12" rx="2" transform="rotate(24 72.5 82)" />
      <path d="M73 90.5a4 4 0 1 1 5.5-3.7l-2.7 1.9z" />
    </g>
  );
}

function Clipboard({ color, led }: { color: string; led: string }) {
  return (
    <g className="robot-tool">
      <rect x="69" y="77" width="12" height="15" rx="2.5" fill={color} />
      <rect x="71.5" y="80" width="7" height="1.6" rx="0.8" fill={led} fillOpacity="0.85" />
      <rect x="71.5" y="83.5" width="7" height="1.6" rx="0.8" fill={led} fillOpacity="0.6" />
      <rect x="71.5" y="87" width="4.5" height="1.6" rx="0.8" fill={led} fillOpacity="0.45" />
    </g>
  );
}

function ClockFace({ color, screen, accent }: { color: string; screen: string; accent: string }) {
  return (
    <g className="robot-clock" transform="translate(48 68)">
      <circle r="5.4" fill={screen} stroke={accent} strokeWidth="1" />
      <circle r="4.2" fill="none" stroke={color} strokeWidth="0.8" strokeOpacity="0.6" />
      <path d="M0 0V-3" stroke={color} strokeWidth="1.2" strokeLinecap="round" className="robot-clock-hand" />
      <path d="M0 0l2.2 1.6" stroke={color} strokeWidth="1" strokeLinecap="round" />
    </g>
  );
}

export function CharacterBubble({ role, state }: { role: Role; state: CharacterState }) {
  const c = CHARACTERS[role];
  return <div className="speech-bubble">{c.quotes[state]}</div>;
}
