import { createBrowserRouter } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { OverviewPage } from "../pages/OverviewPage";
import { MonitoringPage } from "../pages/MonitoringPage";
import { TasksPage } from "../pages/TasksPage";
import { TaskDetailPage } from "../pages/TaskDetailPage";
import { SessionsPage } from "../pages/SessionsPage";
import { QueuePage } from "../pages/QueuePage";
import { FleetPage } from "../pages/FleetPage";
import { ReviewsPage } from "../pages/ReviewsPage";
import { CostsPage } from "../pages/CostsPage";
import { TestingPage } from "../pages/TestingPage";
import { WikiPage } from "../pages/WikiPage";
import { AgentResourcesPage } from "../pages/AgentResourcesPage";
import { SettingsPage } from "../pages/SettingsPage";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: "monitoring", element: <MonitoringPage /> },
      { path: "tasks", element: <TasksPage /> },
      { path: "tasks/:taskId", element: <TaskDetailPage /> },
      { path: "sessions", element: <SessionsPage /> },
      { path: "queue", element: <QueuePage /> },
      { path: "fleet", element: <FleetPage /> },
      { path: "reviews", element: <ReviewsPage /> },
      { path: "costs", element: <CostsPage /> },
      { path: "testing", element: <TestingPage /> },
      { path: "wiki", element: <WikiPage /> },
      { path: "agent-resources", element: <AgentResourcesPage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
]);
