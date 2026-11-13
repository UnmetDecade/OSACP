import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { HostScopeProvider } from "./host-context";
import { LiveProvider } from "./live/context";
import { Dashboard } from "./pages/Dashboard";
import { Builders } from "./pages/Builders";
import { HostsPage } from "./pages/Hosts";
import { HostShow } from "./pages/HostShow";
import { BuilderShow } from "./pages/BuilderShow";
import { SchedulerPage } from "./pages/Scheduler";
import { SchedulerShow } from "./pages/SchedulerShow";
import { ProfilesPage } from "./pages/Profiles";
import { TaskList, TaskShow } from "./pages/Tasks";
import { TerminalPage } from "./pages/Terminal";
import { ChatPage } from "./pages/Chat";
import { LogsPage } from "./pages/Logs";

export default function App() {
  return (
    <BrowserRouter>
      <LiveProvider>
        <HostScopeProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="hosts" element={<HostsPage />} />
            <Route path="hosts/:id" element={<HostShow />} />
            <Route path="builders" element={<Builders />} />
            <Route path="builders/:id" element={<BuilderShow />} />
            <Route path="scheduler" element={<SchedulerPage />} />
            <Route path="scheduler/:id" element={<SchedulerShow />} />
            <Route path="profiles" element={<ProfilesPage />} />
            <Route path="tasks" element={<TaskList />} />
            <Route path="tasks/:id" element={<TaskShow />} />
            <Route path="terminal" element={<TerminalPage />} />
            <Route path="chat" element={<ChatPage />} />
            <Route path="logs" element={<LogsPage />} />
          </Route>
        </Routes>
        </HostScopeProvider>
      </LiveProvider>
    </BrowserRouter>
  );
}
