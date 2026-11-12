import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./i18n";
// xterm's bundled styles (hidden IME input, viewport positioning and scrolling) must load before local styles,
// otherwise a native textarea shows in the terminal's top-left corner and the input area is not managed by xterm.
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
