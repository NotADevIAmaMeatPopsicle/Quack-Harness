import { NavLink, Outlet } from "react-router-dom";
import { useUiPrefs } from "../store/ui-prefs";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/monitoring", label: "Monitoring" },
  { to: "/tasks", label: "Tasks" },
  { to: "/sessions", label: "Sessions" },
  { to: "/queue", label: "Queue" },
  { to: "/fleet", label: "Fleet" },
  { to: "/reviews", label: "Reviews" },
  { to: "/costs", label: "Costs" },
  { to: "/testing", label: "Testing" },
  { to: "/wiki", label: "Wiki" },
  { to: "/agent-resources", label: "Documentation" },
  { to: "/settings", label: "Settings" },
];

export function AppShell() {
  const sidebarCollapsed = useUiPrefs((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiPrefs((s) => s.toggleSidebar);

  return (
    <div className="app-shell" data-sidebar={sidebarCollapsed ? "collapsed" : "open"}>
      <aside className="app-sidebar">
        <div className="app-sidebar-header">
          <button
            type="button"
            className="app-sidebar-toggle"
            aria-label="Toggle sidebar"
            onClick={toggleSidebar}
          >
            {sidebarCollapsed ? ">" : "<"}
          </button>
          {!sidebarCollapsed && <span className="app-brand">Quack Harness</span>}
        </div>
        <nav className="app-nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => "app-nav-link" + (isActive ? " is-active" : "")}
            >
              {sidebarCollapsed ? item.label.charAt(0) : item.label}
            </NavLink>
          ))}
        </nav>
        <div className="app-sidebar-footer">
          <a className="app-nav-link" href="/legacy">
            {sidebarCollapsed ? "L" : "Legacy"}
          </a>
        </div>
      </aside>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
