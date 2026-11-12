import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./i18n";
// xterm 自带样式（隐藏 IME 输入框、视口定位与滚动）必须先于本地样式加载，
// 否则终端左上角会露出一个原生 textarea，输入区也不受 xterm 管理。
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
