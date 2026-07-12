import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, CodeBlock, Icon, PhosphorIcon, type IconName } from "./components/ui";
import { DiscordLogoIcon, GithubLogoIcon, XLogoIcon } from "@wundercorp/baseui/phosphor";
import { UsagePricingDashboard } from "./components/UsagePricingDashboard";
import { ExternalUsageDashboard } from "./components/ExternalUsageDashboard";
import { PublicLocalMetricsPage } from "./components/PublicLocalMetricsPage";
import { BaseUIShowcase } from "./components/BaseUIShowcase";
import {
  beginLogin,
  completeLogin,
  consumeSessionValidationNotice,
  getAuthConfigurationError,
  getSession,
  getSessionUser,
  logout,
  type AuthSession,
} from "./lib/auth";
import {
  createLocalChatCompletion,
  getApiBaseUrl,
  getDashboardUser,
  getGatewayRegistry,
  getLocalModelCatalog,
  getLocalModelInstall,
  getLocalModels,
  getLocalMetrics,
  getLocalRuntimeStatus,
  resetLocalMetrics,
  startLocalModelInstall,
  type DashboardUser,
  type GatewayRecord,
  type InstallableLocalModel,
  type LocalMetricsSnapshot,
  type LocalModelRecord,
  type LocalRuntimeStatus,
  type ModelInstallJob,
} from "./lib/api";
import { formatCompactNumber } from "./lib/format";

type Theme = "dark" | "light";
type Accent = "orange" | "green" | "blue" | "fuchsia";
type DashboardLoadState = "idle" | "loading" | "ready" | "error";
type LocalApiState = "idle" | "loading" | "connected" | "offline";
type ModelTestState = "idle" | "running" | "complete" | "error";
type DashboardRoute =
  | "overview"
  | "models"
  | "resources"
  | "metrics"
  | "gateways"
  | "account";

type DashboardResourceTab = "builderstudio" | "doku";
type DashboardMetricsTab =
  | "overview"
  | "performance"
  | "external"
  | "pricing"
  | "cloud";

interface CloudSessionMetrics {
  syncAttempts: number;
  successfulSyncs: number;
  failedSyncs: number;
  totalLatencyMs: number;
  lastLatencyMs: number;
  lastSyncedAt?: number;
}

interface DashboardCache {
  user?: DashboardUser;
  gateways: GatewayRecord[];
  updatedAt: number;
  cloudMetrics?: CloudSessionMetrics;
}

const dashboardCacheKey = "openmodel:dashboard-cache";
const modelInstallJobStorageKey = "openmodel:model-install-job";
const dashboardSidebarCollapsedStorageKey =
  "openmodel:dashboard-sidebar-collapsed";

const dashboardRouteItems: Array<{
  route: DashboardRoute;
  label: string;
}> = [
  { route: "overview", label: "Overview" },
  { route: "models", label: "Models" },
  { route: "resources", label: "Resources" },
  { route: "metrics", label: "Metrics" },
  { route: "gateways", label: "Gateways" },
  { route: "account", label: "Account" },
];

const dashboardRouteIconNames: Record<DashboardRoute, IconName> = {
  overview: "dashboard",
  models: "box",
  resources: "file",
  metrics: "chart",
  gateways: "server",
  account: "user",
};

function DashboardNavIcon({ route }: { route: DashboardRoute }) {
  return (
    <Icon
      name={dashboardRouteIconNames[route]}
      size={21}
      weight="regular"
      aria-hidden="true"
    />
  );
}

function readDashboardRoute(): DashboardRoute {
  const route = new URLSearchParams(window.location.search).get("view");
  if (route === "builderstudio" || route === "doku") {
    return "resources";
  }
  return dashboardRouteItems.some((item) => item.route === route)
    ? (route as DashboardRoute)
    : "overview";
}

function readDashboardResourceTab(): DashboardResourceTab {
  const searchParams = new URLSearchParams(window.location.search);
  const legacyRoute = searchParams.get("view");
  if (legacyRoute === "doku") {
    return "doku";
  }
  if (legacyRoute === "builderstudio") {
    return "builderstudio";
  }
  return searchParams.get("tool") === "doku" ? "doku" : "builderstudio";
}

function readDashboardMetricsTab(): DashboardMetricsTab {
  const tab = new URLSearchParams(window.location.search).get("tab");
  if (
    tab === "performance" ||
    tab === "external" ||
    tab === "pricing" ||
    tab === "cloud"
  ) {
    return tab;
  }
  return "overview";
}

function readDashboardCache() {
  const storedValue = sessionStorage.getItem(dashboardCacheKey);
  if (!storedValue) {
    return undefined;
  }

  try {
    const parsedValue = JSON.parse(storedValue) as DashboardCache;
    if (!Array.isArray(parsedValue.gateways)) {
      return undefined;
    }
    return parsedValue;
  } catch {
    sessionStorage.removeItem(dashboardCacheKey);
    return undefined;
  }
}

function writeDashboardCache(cache: DashboardCache) {
  sessionStorage.setItem(dashboardCacheKey, JSON.stringify(cache));
}

function formatBytes(value: number | undefined) {
  if (!Number.isFinite(value) || !value) {
    return "0 MB";
  }
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }
  return `${(value / 1024 / 1024).toFixed(value >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function formatMetricNumber(value: number | undefined) {
  return formatCompactNumber(value, 1);
}

function formatDuration(milliseconds: number | undefined) {
  if (!Number.isFinite(milliseconds)) {
    return "0 MS";
  }
  if ((milliseconds ?? 0) >= 1000) {
    return `${((milliseconds ?? 0) / 1000).toFixed(2)} S`;
  }
  return `${Math.round(milliseconds ?? 0)} MS`;
}

function formatUptime(totalSeconds: number | undefined) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds ?? 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  if (hours > 0) {
    return `${hours}H ${String(minutes).padStart(2, "0")}M`;
  }
  if (minutes > 0) {
    return `${minutes}M ${String(seconds).padStart(2, "0")}S`;
  }
  return `${seconds}S`;
}

function formatPercent(value: number | undefined) {
  if (!Number.isFinite(value)) {
    return "0%";
  }
  return `${Math.max(0, Math.min(100, value ?? 0)).toFixed(1)}%`;
}

const gateways = [
  ["Hugging Face", "hf://", "GGUF and registry artifacts"],
  ["Direct HTTPS", "https://", "Portable model artifacts"],
  ["Ollama", "ollama://", "Native Ollama registry models"],
  ["Your gateway", "npm package", "Versioned SDK and explicit registration"],
];

const starterModelFallback: InstallableLocalModel = {
  id: "qwen2.5-0.5b-instruct-q4",
  name: "Qwen2.5 0.5B Instruct",
  description:
    "A compact instruction model intended as a quick first local download.",
  reference:
    "hf://Qwen/Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q4_k_m.gguf",
  alias: "qwen-small",
  format: "GGUF · Q4_K_M",
  parameterCount: "0.5B",
  sizeBytes: 491000000,
  license: "Apache-2.0",
  sourceUrl: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF",
  installed: false,
};

const openModelBanner = String.raw` ██████╗ ██████╗ ███████╗███╗   ██╗███╗   ███╗ ██████╗ ██████╗ ███████╗██╗     
██╔═══██╗██╔══██╗██╔════╝████╗  ██║████╗ ████║██╔═══██╗██╔══██╗██╔════╝██║     
██║   ██║██████╔╝█████╗  ██╔██╗ ██║██╔████╔██║██║   ██║██║  ██║█████╗  ██║     
██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██║╚██╔╝██║██║   ██║██║  ██║██╔══╝  ██║     
╚██████╔╝██║     ███████╗██║ ╚████║██║ ╚═╝ ██║╚██████╔╝██████╔╝███████╗███████╗
 ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝╚═╝     ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝`;

export function App() {
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem("openmodel:theme") === "light" ? "light" : "dark",
  );
  const [accent, setAccent] = useState<Accent>(
    () => (localStorage.getItem("openmodel:accent") as Accent) || "blue",
  );
  const [session, setSession] = useState<AuthSession | undefined>(() =>
    getSession(),
  );
  const [authenticationBusy, setAuthenticationBusy] = useState(
    () => window.location.pathname === "/auth/callback",
  );
  const [authenticationError, setAuthenticationError] = useState<
    string | undefined
  >(() => consumeSessionValidationNotice());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = accent;
    localStorage.setItem("openmodel:theme", theme);
    localStorage.setItem("openmodel:accent", accent);
  }, [theme, accent]);

  useEffect(() => {
    let active = true;

    completeLogin()
      .then((result) => {
        if (!active) {
          return;
        }
        if (result.completed) {
          setSession(result.session ?? getSession());
          setAuthenticationError(undefined);
        }
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        setAuthenticationError(
          error instanceof Error ? error.message : "Authentication failed.",
        );
      })
      .finally(() => {
        if (active) {
          setAuthenticationBusy(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const startSignIn = useCallback(async (returnTo = "/dashboard") => {
    setAuthenticationBusy(true);
    setAuthenticationError(undefined);
    try {
      await beginLogin(returnTo);
    } catch (error) {
      setAuthenticationBusy(false);
      setAuthenticationError(
        error instanceof Error ? error.message : "Unable to start sign-in.",
      );
    }
  }, []);

  const signOut = useCallback(async () => {
    setAuthenticationBusy(true);
    setAuthenticationError(undefined);
    try {
      await logout();
    } catch (error) {
      setAuthenticationBusy(false);
      setAuthenticationError(
        error instanceof Error ? error.message : "Unable to sign out.",
      );
    }
  }, []);

  const synchronizeSession = useCallback(() => {
    const storedSession = getSession();
    const validationNotice = consumeSessionValidationNotice();
    if (validationNotice) {
      setAuthenticationError(validationNotice);
    }

    setSession((currentSession) => {
      if (!storedSession) {
        if (currentSession) {
          return undefined;
        }

        return currentSession;
      }

      if (
        currentSession?.access_token === storedSession.access_token &&
        currentSession?.id_token === storedSession.id_token &&
        currentSession?.refresh_token === storedSession.refresh_token &&
        currentSession?.expiresAt === storedSession.expiresAt
      ) {
        return currentSession;
      }

      return storedSession;
    });
  }, []);

  const currentPath = window.location.pathname;
  const isDashboard =
    currentPath === "/dashboard" || currentPath.startsWith("/dashboard/");
  const isBaseUI =
    currentPath === "/baseui" || currentPath.startsWith("/baseui/");
  const isAuthCallback =
    currentPath === "/auth/callback" ||
    currentPath.startsWith("/auth/callback/");
  const sessionUser = useMemo(() => getSessionUser(session), [session]);

  useEffect(() => {
    const dashboardInterfaceActive = isDashboard || isAuthCallback;
    document.body.classList.toggle("baseui-interface-active", isBaseUI);
    document.body.classList.toggle(
      "dashboard-interface-active",
      dashboardInterfaceActive,
    );

    return () => {
      document.body.classList.remove("dashboard-interface-active");
      document.body.classList.remove("baseui-interface-active");
    };
  }, [isAuthCallback, isBaseUI, isDashboard]);

  return (
    <div className="page-shell">
      {!isDashboard && !isBaseUI ? (
        <SiteHeader
          theme={theme}
          accent={accent}
          session={session}
          sessionLabel={sessionUser?.email ?? sessionUser?.username}
          authenticationBusy={authenticationBusy}
          onThemeChange={() =>
            setTheme((currentTheme) =>
              currentTheme === "dark" ? "light" : "dark",
            )
          }
          onAccentChange={setAccent}
          onSignIn={() => void startSignIn("/dashboard")}
          onSignOut={() => void signOut()}
        />
      ) : null}

      {authenticationError && !isDashboard && !isBaseUI && !isAuthCallback ? (
        <div className="authentication-notice authentication-notice-error">
          <span>AUTH_ERROR</span>
          <strong>{authenticationError}</strong>
          <button
            type="button"
            onClick={() => setAuthenticationError(undefined)}
          >
            DISMISS
          </button>
        </div>
      ) : null}

      {isBaseUI ? (
        <BaseUIShowcase
          theme={theme}
          onThemeChange={() =>
            setTheme((currentTheme) =>
              currentTheme === "dark" ? "light" : "dark",
            )
          }
        />
      ) : isAuthCallback ? (
        <AuthCallbackPage
          theme={theme}
          busy={authenticationBusy}
          error={authenticationError}
          onRetry={() => void startSignIn("/dashboard")}
        />
      ) : isDashboard ? (
        <DashboardPage
          theme={theme}
          session={session}
          authenticationError={authenticationError}
          onThemeChange={() =>
            setTheme((currentTheme) =>
              currentTheme === "dark" ? "light" : "dark",
            )
          }
          onSignIn={() => void startSignIn("/dashboard")}
          onSignOut={() => void signOut()}
          onSessionChange={synchronizeSession}
        />
      ) : (
        <LandingPage />
      )}

      {!isDashboard && !isBaseUI && !isAuthCallback ? <SiteFooter /> : null}
    </div>
  );
}

interface SiteHeaderProps {
  theme: Theme;
  accent: Accent;
  session?: AuthSession;
  sessionLabel?: string;
  authenticationBusy: boolean;
  onThemeChange: () => void;
  onAccentChange: (accent: Accent) => void;
  onSignIn: () => void;
  onSignOut: () => void;
}

function SiteHeader({
  theme,
  accent,
  session,
  sessionLabel,
  authenticationBusy,
  onThemeChange,
  onAccentChange,
  onSignIn,
  onSignOut,
}: SiteHeaderProps) {
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const profileInitial = (
    sessionLabel?.trim().slice(0, 1) || "O"
  ).toUpperCase();

  useEffect(() => {
    if (!profileMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        profileMenuRef.current &&
        !profileMenuRef.current.contains(event.target as Node)
      ) {
        setProfileMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProfileMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [profileMenuOpen]);

  return (
    <header className="site-header">
      <a className="brand" href="/">
        <span className="brand-prompt" aria-hidden="true">
          &gt;_
        </span>
        <span>OPENMODEL.SH</span>
      </a>

      <nav className="nav-links">
        <a href="/#gateways">[GATEWAYS]</a>
        <a href="/#api">[API]</a>
        <a href="/dashboard">[DASHBOARD]</a>
        <a
          href="https://github.com/wundercorp/openmodel"
          target="_blank"
          rel="noopener noreferrer"
        >
          [GITHUB]
        </a>
      </nav>

      <div className="header-actions">
        <select
          aria-label="Accent color"
          value={accent}
          onChange={(event) => onAccentChange(event.target.value as Accent)}
        >
          <option value="orange">ORANGE</option>
          <option value="green">GREEN</option>
          <option value="blue">BLUE</option>
          <option value="fuchsia">FUCHSIA</option>
        </select>

        <Button variant="ghost" onClick={onThemeChange}>
          {theme === "dark" ? "LIGHT" : "OLED"}
        </Button>

        {session ? (
          <div className="site-profile-menu" ref={profileMenuRef}>
            <button
              className="site-profile-trigger"
              type="button"
              aria-haspopup="menu"
              aria-expanded={profileMenuOpen}
              onClick={() =>
                setProfileMenuOpen((currentValue) => !currentValue)
              }
            >
              <span className="site-profile-avatar" aria-hidden="true">
                {profileInitial}
              </span>
              <span className="site-profile-label">
                {sessionLabel ?? "ACCOUNT"}
              </span>
              <span aria-hidden="true">{profileMenuOpen ? "▲" : "▼"}</span>
            </button>

            {profileMenuOpen ? (
              <div className="site-profile-dropdown" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setProfileMenuOpen(false);
                    window.location.assign("/dashboard?view=account");
                  }}
                >
                  ACCOUNT PROFILE
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={authenticationBusy}
                  onClick={() => {
                    setProfileMenuOpen(false);
                    onSignOut();
                  }}
                >
                  {authenticationBusy ? "WAIT" : "LOGOUT"}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <Button disabled={authenticationBusy} onClick={onSignIn}>
            {authenticationBusy ? "CONNECTING" : "SIGN IN"}
          </Button>
        )}
      </div>
    </header>
  );
}

function LandingPage() {
  return (
    <main id="top">
      <section className="hero section">
        <div className="hero-copy">
          <Badge>GATEWAY-FIRST LOCAL INFERENCE</Badge>
          <h1>LLM INFERENCE GATEWAY</h1>
          <p className="lead">
            Download and run language models locally, monitor telemetry, track
            token usage and costs, and more.
          </p>

          <div className="hero-actions">
            <Button
              onClick={() =>
                navigator.clipboard.writeText(
                  "npm install -g @wundercorp/openmodel",
                )
              }
            >
              COPY INSTALL COMMAND
            </Button>

            <Button
              variant="outline"
              onClick={() => window.location.assign("/dashboard")}
            >
              TRACK INFERENCE
            </Button>
          </div>

          <div className="trust-row">
            <span>APACHE-2.0</span>
            <span>EXPLICIT PLUGINS</span>
            <span>COGNITO + PKCE</span>
            <span>OPENAI + OLLAMA APIS</span>
          </div>
        </div>

        <Card className="terminal-card">
          <div className="terminal-title">
            <span></span>
            <span></span>
            <span></span>
            <strong>OPENMODEL::TERMINAL</strong>
          </div>
          <CodeBlock>{`$ npm i -g @wundercorp/openmodel
$ om pull hf://owner/repo/model.gguf --alias local
Downloading model.gguf: 812.4 MiB
Installed owner-repo-model-gguf as local.

$ om serve local --port 11435
OpenModel local API listening on http://127.0.0.1:11435`}</CodeBlock>
        </Card>
      </section>

      <section id="gateways" className="section">
        <div className="section-heading">
          <Badge>INTEROPERABILITY</Badge>
          <h2>GATEWAYS TO ANY LLM.</h2>
          <p>
            Contributors add providers through a small public SDK. Core commands
            remain provider-neutral and runtime-neutral.
          </p>
        </div>

        <div className="gateway-grid">
          {gateways.map(([name, scheme, description], gatewayIndex) => (
            <Card key={name}>
              <span className="card-index">
                {String(gatewayIndex + 1).padStart(2, "0")}
              </span>
              <h3>{name}</h3>
              <code>{scheme}</code>
              <p>{description}</p>
            </Card>
          ))}
        </div>
      </section>

      <section id="api" className="section split-section">
        <div>
          <Badge>LOCAL API</Badge>
          <h2>DROP INTO EXISTING TOOLING</h2>
          <p>
            Serve installed models through OpenAI-compatible chat completions or
            Ollama-compatible generation endpoints.
          </p>
          <ul>
            <li>GET /v1/models</li>
            <li>POST /v1/chat/completions</li>
            <li>GET /api/tags</li>
            <li>POST /api/generate</li>
          </ul>
        </div>

        <Card>
          <CodeBlock>{`curl http://127.0.0.1:11435/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{
    "model": "local",
    "messages": [{"role":"user","content":"Hello"}]
  }'`}</CodeBlock>
        </Card>
      </section>
    </main>
  );
}

interface AuthCallbackPageProps {
  theme: Theme;
  busy: boolean;
  error?: string;
  onRetry: () => void;
}

function AuthCallbackPage({ theme, busy, error, onRetry }: AuthCallbackPageProps) {
  return (
    <main className="bui-root auth-callback-page" data-bui-theme={theme}>
      <Card className="auth-callback-panel">
        <div className="terminal-title">
          <span></span>
          <span></span>
          <span></span>
          <strong>AUTH::CALLBACK</strong>
        </div>
        <div className="auth-callback-content">
          <Badge>{error ? "AUTHENTICATION ERROR" : "COGNITO CALLBACK"}</Badge>
          <h1>{error ? "Sign in failed" : "Establishing session"}</h1>
          <p>
            {error
              ? error
              : "Exchanging the authorization code, validating state, and opening your dashboard session."}
          </p>
          <div className="auth-callback-progress" aria-hidden="true">
            <span></span>
          </div>
          {error ? (
            <div className="hero-actions">
              <Button onClick={onRetry}>Try sign in again</Button>
              <a className="button button-outline" href="/">
                Return home
              </a>
            </div>
          ) : (
            <span className="dashboard-monospace">
              {busy ? "STATUS: PROCESSING" : "STATUS: REDIRECTING"}
            </span>
          )}
        </div>
      </Card>
    </main>
  );
}

interface DashboardPageProps {
  theme: Theme;
  session?: AuthSession;
  authenticationError?: string;
  onThemeChange: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onSessionChange: () => void;
}

function DashboardPage({
  theme,
  session,
  authenticationError,
  onThemeChange,
  onSignIn,
  onSignOut,
  onSessionChange,
}: DashboardPageProps) {
  const [initialDashboardCache] = useState(() => readDashboardCache());
  const [activeRoute, setActiveRoute] = useState<DashboardRoute>(() =>
    readDashboardRoute(),
  );
  const [activeResourceTab, setActiveResourceTab] =
    useState<DashboardResourceTab>(() => readDashboardResourceTab());
  const [activeMetricsTab, setActiveMetricsTab] = useState<DashboardMetricsTab>(
    () => readDashboardMetricsTab(),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(dashboardSidebarCollapsedStorageKey) === "true",
  );
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [loadState, setLoadState] = useState<DashboardLoadState>(() =>
    initialDashboardCache ? "ready" : "idle",
  );
  const [cloudRefreshing, setCloudRefreshing] = useState(false);
  const [cloudMetrics, setCloudMetrics] = useState<CloudSessionMetrics>(
    () =>
      initialDashboardCache?.cloudMetrics ?? {
        syncAttempts: 0,
        successfulSyncs: 0,
        failedSyncs: 0,
        totalLatencyMs: 0,
        lastLatencyMs: 0,
        lastSyncedAt: initialDashboardCache?.updatedAt,
      },
  );
  const [lastCloudSyncAt, setLastCloudSyncAt] = useState<number | undefined>(
    initialDashboardCache?.updatedAt,
  );
  const [dashboardUser, setDashboardUser] = useState<DashboardUser | undefined>(
    initialDashboardCache?.user,
  );
  const [gatewayRecords, setGatewayRecords] = useState<GatewayRecord[]>(
    initialDashboardCache?.gateways ?? [],
  );
  const [dashboardError, setDashboardError] = useState<string>();
  const [localApiUrl, setLocalApiUrl] = useState(
    () =>
      localStorage.getItem("openmodel:local-api-url") ??
      "http://127.0.0.1:11435",
  );
  const [localApiInput, setLocalApiInput] = useState(localApiUrl);
  const [localApiState, setLocalApiState] = useState<LocalApiState>("idle");
  const [localApiError, setLocalApiError] = useState<string>();
  const [localModels, setLocalModels] = useState<LocalModelRecord[]>([]);
  const [localModelCatalog, setLocalModelCatalog] = useState<
    InstallableLocalModel[]
  >([]);
  const [localRuntimeStatus, setLocalRuntimeStatus] =
    useState<LocalRuntimeStatus>();
  const [localRuntimeError, setLocalRuntimeError] = useState<string>();
  const [localMetrics, setLocalMetrics] = useState<LocalMetricsSnapshot>();
  const [localMetricsLoading, setLocalMetricsLoading] = useState(false);
  const [localMetricsError, setLocalMetricsError] = useState<string>();
  const [localMetricsResetting, setLocalMetricsResetting] = useState(false);
  const [modelInstallJob, setModelInstallJob] = useState<ModelInstallJob>();
  const [modelInstallError, setModelInstallError] = useState<string>();
  const [selectedModelId, setSelectedModelId] = useState<string>();
  const [modelTestState, setModelTestState] = useState<ModelTestState>("idle");
  const [modelTestOutput, setModelTestOutput] = useState<string>();
  const [modelTestError, setModelTestError] = useState<string>();
  const [copiedCommand, setCopiedCommand] = useState<string>();
  const dashboardRequestId = useRef(0);
  const localApiRequestId = useRef(0);
  const dashboardAbortController = useRef<AbortController | undefined>(
    undefined,
  );
  const localApiAbortController = useRef<AbortController | undefined>(
    undefined,
  );
  const modelInstallAbortController = useRef<AbortController | undefined>(
    undefined,
  );
  const modelTestAbortController = useRef<AbortController | undefined>(
    undefined,
  );
  const localMetricsAbortController = useRef<AbortController | undefined>(
    undefined,
  );
  const localMetricsRequestId = useRef(0);
  const initialCloudLoadStarted = useRef(false);
  const dashboardProfileMenuRef = useRef<HTMLDivElement | null>(null);
  const dashboardData = useRef({
    user: initialDashboardCache?.user,
    gateways: initialDashboardCache?.gateways ?? [],
  });
  const cloudMetricsData = useRef<CloudSessionMetrics>(
    initialDashboardCache?.cloudMetrics ?? {
      syncAttempts: 0,
      successfulSyncs: 0,
      failedSyncs: 0,
      totalLatencyMs: 0,
      lastLatencyMs: 0,
      lastSyncedAt: initialDashboardCache?.updatedAt,
    },
  );
  const localUser = useMemo(() => getSessionUser(session), [session]);
  const sessionAccessToken = session?.access_token;

  const navigateDashboard = useCallback((route: DashboardRoute) => {
    const nextUrl =
      route === "overview" ? "/dashboard" : `/dashboard?view=${route}`;
    window.history.pushState({ dashboardRoute: route }, "", nextUrl);
    setActiveRoute(route);
    if (route === "resources") {
      setActiveResourceTab("builderstudio");
    }
    if (route === "metrics") {
      setActiveMetricsTab("overview");
    }
    setProfileMenuOpen(false);
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const navigateResourceTab = useCallback((tab: DashboardResourceTab) => {
    const nextUrl = `/dashboard?view=resources&tool=${tab}`;
    window.history.pushState(
      { dashboardRoute: "resources", dashboardResourceTab: tab },
      "",
      nextUrl,
    );
    setActiveRoute("resources");
    setActiveResourceTab(tab);
    setProfileMenuOpen(false);
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const navigateMetricsTab = useCallback((tab: DashboardMetricsTab) => {
    const nextUrl = `/dashboard?view=metrics&tab=${tab}`;
    window.history.pushState(
      { dashboardRoute: "metrics", dashboardMetricsTab: tab },
      "",
      nextUrl,
    );
    setActiveRoute("metrics");
    setActiveMetricsTab(tab);
    setProfileMenuOpen(false);
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const navigateHome = useCallback(() => {
    window.location.assign("/");
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setActiveRoute(readDashboardRoute());
      setActiveResourceTab(readDashboardResourceTab());
      setActiveMetricsTab(readDashboardMetricsTab());
      window.scrollTo({ top: 0, behavior: "auto" });
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    localStorage.setItem(
      dashboardSidebarCollapsedStorageKey,
      String(sidebarCollapsed),
    );
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!profileMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        dashboardProfileMenuRef.current &&
        !dashboardProfileMenuRef.current.contains(event.target as Node)
      ) {
        setProfileMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProfileMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [profileMenuOpen]);

  const loadDashboard = useCallback(async () => {
    if (!sessionAccessToken) {
      return;
    }

    dashboardAbortController.current?.abort();
    const abortController = new AbortController();
    dashboardAbortController.current = abortController;

    const requestId = dashboardRequestId.current + 1;
    dashboardRequestId.current = requestId;
    const hasExistingData = Boolean(
      dashboardData.current.user || dashboardData.current.gateways.length > 0,
    );

    setCloudRefreshing(true);
    setDashboardError(undefined);
    if (!hasExistingData) {
      setLoadState("loading");
    }

    const cloudSyncStartedAt = performance.now();
    const [userResult, gatewayResult] = await Promise.allSettled([
      getDashboardUser(abortController.signal),
      getGatewayRegistry(abortController.signal),
    ]);

    if (
      abortController.signal.aborted ||
      requestId !== dashboardRequestId.current
    ) {
      return;
    }

    const nextUser =
      userResult.status === "fulfilled"
        ? userResult.value
        : dashboardData.current.user;
    const nextGateways =
      gatewayResult.status === "fulfilled"
        ? gatewayResult.value
        : dashboardData.current.gateways;

    if (userResult.status === "fulfilled") {
      dashboardData.current.user = userResult.value;
      setDashboardUser(userResult.value);
    }
    if (gatewayResult.status === "fulfilled") {
      dashboardData.current.gateways = gatewayResult.value;
      setGatewayRecords(gatewayResult.value);
    }

    const cloudDataUpdated =
      userResult.status === "fulfilled" || gatewayResult.status === "fulfilled";
    const updatedAt = cloudDataUpdated
      ? Date.now()
      : (cloudMetricsData.current.lastSyncedAt ?? Date.now());
    if (cloudDataUpdated) {
      setLastCloudSyncAt(updatedAt);
    }

    const errors: string[] = [];
    if (userResult.status === "rejected") {
      errors.push(
        userResult.reason instanceof Error
          ? userResult.reason.message
          : "Unable to load the authenticated user.",
      );
    }
    if (gatewayResult.status === "rejected") {
      errors.push(
        gatewayResult.reason instanceof Error
          ? gatewayResult.reason.message
          : "Unable to load the gateway registry.",
      );
    }

    const cloudSyncLatencyMs = Math.max(
      0,
      Math.round(performance.now() - cloudSyncStartedAt),
    );
    const previousCloudMetrics = cloudMetricsData.current;
    const nextCloudMetrics: CloudSessionMetrics = {
      syncAttempts: previousCloudMetrics.syncAttempts + 1,
      successfulSyncs:
        previousCloudMetrics.successfulSyncs + (errors.length === 0 ? 1 : 0),
      failedSyncs:
        previousCloudMetrics.failedSyncs + (errors.length > 0 ? 1 : 0),
      totalLatencyMs: previousCloudMetrics.totalLatencyMs + cloudSyncLatencyMs,
      lastLatencyMs: cloudSyncLatencyMs,
      lastSyncedAt:
        errors.length === 0 ? Date.now() : previousCloudMetrics.lastSyncedAt,
    };
    cloudMetricsData.current = nextCloudMetrics;
    setCloudMetrics(nextCloudMetrics);
    if (cloudDataUpdated || hasExistingData) {
      writeDashboardCache({
        user: nextUser,
        gateways: nextGateways,
        updatedAt,
        cloudMetrics: nextCloudMetrics,
      });
    }

    onSessionChange();
    setCloudRefreshing(false);

    if (errors.length > 0) {
      setDashboardError(errors.join(" "));
      setLoadState(hasExistingData ? "ready" : "error");
      return;
    }

    setLoadState("ready");
  }, [onSessionChange, sessionAccessToken]);

  const loadLocalModelRegistry = useCallback(async (requestedUrl: string) => {
    const normalizedUrl = requestedUrl.trim().replace(/\/$/, "");
    if (!normalizedUrl) {
      setLocalApiState("offline");
      setLocalApiError("Enter the URL of the local OpenModel API.");
      return false;
    }

    localApiAbortController.current?.abort();
    const abortController = new AbortController();
    localApiAbortController.current = abortController;
    const requestId = localApiRequestId.current + 1;
    localApiRequestId.current = requestId;
    let requestTimedOut = false;
    const timeoutId = window.setTimeout(() => {
      requestTimedOut = true;
      abortController.abort();
    }, 5000);

    setLocalApiUrl(normalizedUrl);
    setLocalApiInput(normalizedUrl);
    localStorage.setItem("openmodel:local-api-url", normalizedUrl);
    setLocalApiState("loading");
    setLocalApiError(undefined);

    try {
      const [modelsResult, catalogResult, runtimeResult, metricsResult] =
        await Promise.allSettled([
          getLocalModels(normalizedUrl, abortController.signal),
          getLocalModelCatalog(normalizedUrl, abortController.signal),
          getLocalRuntimeStatus(normalizedUrl, abortController.signal),
          getLocalMetrics(normalizedUrl, abortController.signal),
        ]);

      if (requestId !== localApiRequestId.current) {
        return false;
      }
      if (modelsResult.status === "rejected") {
        throw modelsResult.reason;
      }

      setLocalModels(modelsResult.value);
      setLocalApiState("connected");

      if (catalogResult.status === "fulfilled") {
        setLocalModelCatalog(catalogResult.value);
        setModelInstallError(undefined);
      } else {
        setLocalModelCatalog([]);
        setModelInstallError(
          "One-click model installs require the latest OpenModel CLI. Run npm install -g @wundercorp/openmodel@latest, restart om serve, and reconnect.",
        );
      }

      if (runtimeResult.status === "fulfilled") {
        setLocalRuntimeStatus(runtimeResult.value);
        setLocalRuntimeError(undefined);
      } else {
        setLocalRuntimeStatus(undefined);
        setLocalRuntimeError(
          "Runtime detection requires the latest OpenModel CLI. Update the CLI, restart om serve, and reconnect.",
        );
      }

      if (metricsResult.status === "fulfilled") {
        setLocalMetrics(metricsResult.value);
        setLocalMetricsError(undefined);
      } else {
        setLocalMetrics(undefined);
        setLocalMetricsError(
          "Local metrics require the latest OpenModel CLI. Update the CLI, restart om serve, and reconnect.",
        );
      }

      const storedInstallJobId = localStorage.getItem(
        modelInstallJobStorageKey,
      );
      if (storedInstallJobId && catalogResult.status === "fulfilled") {
        try {
          const storedJob = await getLocalModelInstall(
            normalizedUrl,
            storedInstallJobId,
            abortController.signal,
          );
          if (requestId === localApiRequestId.current) {
            setModelInstallJob(storedJob);
          }
        } catch {
          localStorage.removeItem(modelInstallJobStorageKey);
        }
      }

      return true;
    } catch (error) {
      if (requestId !== localApiRequestId.current) {
        return false;
      }
      setLocalModels([]);
      setLocalModelCatalog([]);
      setLocalRuntimeStatus(undefined);
      setLocalRuntimeError(undefined);
      setLocalMetrics(undefined);
      setLocalMetricsError(undefined);
      setLocalApiState("offline");
      setLocalApiError(
        requestTimedOut
          ? "No local OpenModel server responded within 5 seconds."
          : error instanceof Error
            ? error.message
            : "The browser could not reach the local OpenModel API.",
      );
      return false;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }, []);

  const refreshLocalModelsSilently = useCallback(
    async (requestedUrl: string) => {
      const [modelsResult, catalogResult, runtimeResult, metricsResult] =
        await Promise.allSettled([
          getLocalModels(requestedUrl),
          getLocalModelCatalog(requestedUrl),
          getLocalRuntimeStatus(requestedUrl),
          getLocalMetrics(requestedUrl),
        ]);

      if (modelsResult.status === "rejected") {
        return false;
      }

      setLocalModels(modelsResult.value);
      if (catalogResult.status === "fulfilled") {
        setLocalModelCatalog(catalogResult.value);
      }
      if (runtimeResult.status === "fulfilled") {
        setLocalRuntimeStatus(runtimeResult.value);
        setLocalRuntimeError(undefined);
      }
      if (metricsResult.status === "fulfilled") {
        setLocalMetrics(metricsResult.value);
        setLocalMetricsError(undefined);
      }
      setLocalApiState("connected");
      setLocalApiError(undefined);
      return true;
    },
    [],
  );

  const loadLocalMetricsSnapshot = useCallback(
    async (showLoadingState = false) => {
      if (localApiState !== "connected") {
        return false;
      }

      localMetricsAbortController.current?.abort();
      const abortController = new AbortController();
      localMetricsAbortController.current = abortController;
      const requestId = localMetricsRequestId.current + 1;
      localMetricsRequestId.current = requestId;

      if (showLoadingState) {
        setLocalMetricsLoading(true);
      }

      try {
        const metrics = await getLocalMetrics(
          localApiUrl,
          abortController.signal,
        );
        if (
          abortController.signal.aborted ||
          requestId !== localMetricsRequestId.current
        ) {
          return false;
        }
        setLocalMetrics(metrics);
        setLocalMetricsError(undefined);
        return true;
      } catch (error) {
        if (
          abortController.signal.aborted ||
          requestId !== localMetricsRequestId.current
        ) {
          return false;
        }
        setLocalMetricsError(
          error instanceof Error
            ? error.message
            : "The dashboard could not load local inference metrics.",
        );
        return false;
      } finally {
        if (requestId === localMetricsRequestId.current) {
          setLocalMetricsLoading(false);
        }
      }
    },
    [localApiState, localApiUrl],
  );

  const clearLocalMetrics = useCallback(async () => {
    if (localApiState !== "connected") {
      return;
    }

    localMetricsAbortController.current?.abort();
    const abortController = new AbortController();
    localMetricsAbortController.current = abortController;
    setLocalMetricsResetting(true);
    setLocalMetricsError(undefined);

    try {
      await resetLocalMetrics(localApiUrl, abortController.signal);
      if (localMetricsAbortController.current === abortController) {
        localMetricsAbortController.current = undefined;
      }
      await loadLocalMetricsSnapshot(false);
    } catch (error) {
      if (!abortController.signal.aborted) {
        setLocalMetricsError(
          error instanceof Error
            ? error.message
            : "The local metrics could not be reset.",
        );
      }
    } finally {
      setLocalMetricsResetting(false);
    }
  }, [loadLocalMetricsSnapshot, localApiState, localApiUrl]);

  const disconnectLocalApi = useCallback(() => {
    localApiAbortController.current?.abort();
    modelInstallAbortController.current?.abort();
    modelTestAbortController.current?.abort();
    localMetricsAbortController.current?.abort();
    localApiRequestId.current += 1;
    localMetricsRequestId.current += 1;
    setLocalApiState("idle");
    setLocalApiError(undefined);
    setLocalModels([]);
    setLocalModelCatalog([]);
    setLocalRuntimeStatus(undefined);
    setLocalRuntimeError(undefined);
    setLocalMetrics(undefined);
    setLocalMetricsError(undefined);
    setLocalMetricsLoading(false);
    setLocalMetricsResetting(false);
    setModelInstallJob(undefined);
    setModelInstallError(undefined);
    setSelectedModelId(undefined);
    setModelTestState("idle");
    setModelTestOutput(undefined);
    setModelTestError(undefined);
  }, []);

  const installCatalogModel = useCallback(
    async (catalogId: string) => {
      setModelInstallError(undefined);
      const normalizedUrl = localApiInput.trim().replace(/\/$/, "");
      const connected =
        localApiState === "connected" ||
        (await loadLocalModelRegistry(normalizedUrl));
      if (!connected) {
        setModelInstallError(
          "Start the local OpenModel service with om serve --port 11435, then press Install again.",
        );
        return;
      }

      modelInstallAbortController.current?.abort();
      const abortController = new AbortController();
      modelInstallAbortController.current = abortController;

      try {
        const job = await startLocalModelInstall(
          normalizedUrl,
          catalogId,
          abortController.signal,
        );
        setModelInstallJob(job);
        localStorage.setItem(modelInstallJobStorageKey, job.id);

        if (job.status === "completed") {
          localStorage.removeItem(modelInstallJobStorageKey);
          await refreshLocalModelsSilently(normalizedUrl);
          if (job.modelId) {
            setSelectedModelId(job.modelId);
          }
        }
      } catch (error) {
        setModelInstallError(
          error instanceof Error
            ? error.message
            : "The local model installation could not be started.",
        );
      }
    },
    [
      loadLocalModelRegistry,
      localApiInput,
      localApiState,
      refreshLocalModelsSilently,
    ],
  );

  const activeModelInstallJobId =
    modelInstallJob && !["completed", "error"].includes(modelInstallJob.status)
      ? modelInstallJob.id
      : undefined;

  useEffect(() => {
    if (!activeModelInstallJobId) {
      return;
    }

    let active = true;
    let timeoutId: number | undefined;
    const abortController = new AbortController();
    modelInstallAbortController.current = abortController;

    const pollInstall = async () => {
      try {
        const job = await getLocalModelInstall(
          localApiUrl,
          activeModelInstallJobId,
          abortController.signal,
        );
        if (!active) {
          return;
        }

        setModelInstallJob(job);
        if (job.status === "completed") {
          localStorage.removeItem(modelInstallJobStorageKey);
          await refreshLocalModelsSilently(localApiUrl);
          if (job.modelId) {
            setSelectedModelId(job.modelId);
          }
          return;
        }
        if (job.status === "error") {
          localStorage.removeItem(modelInstallJobStorageKey);
          setModelInstallError(job.error ?? "The model installation failed.");
          return;
        }

        timeoutId = window.setTimeout(() => {
          void pollInstall();
        }, 650);
      } catch (error) {
        if (!active || abortController.signal.aborted) {
          return;
        }
        setModelInstallError(
          error instanceof Error
            ? error.message
            : "The dashboard lost the model installation status.",
        );
      }
    };

    void pollInstall();

    return () => {
      active = false;
      abortController.abort();
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [activeModelInstallJobId, localApiUrl, refreshLocalModelsSilently]);

  useEffect(() => {
    if (!sessionAccessToken || initialCloudLoadStarted.current) {
      return;
    }

    initialCloudLoadStarted.current = true;
    void loadDashboard();
  }, [loadDashboard, sessionAccessToken]);

  useEffect(() => {
    if (activeRoute !== "metrics" || localApiState !== "connected") {
      return;
    }

    let active = true;
    let intervalId: number | undefined;
    void loadLocalMetricsSnapshot(true).then((loaded) => {
      if (!active || !loaded) {
        return;
      }
      intervalId = window.setInterval(() => {
        void loadLocalMetricsSnapshot(false);
      }, 2500);
    });

    return () => {
      active = false;
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
      }
      localMetricsAbortController.current?.abort();
    };
  }, [activeRoute, loadLocalMetricsSnapshot, localApiState]);

  useEffect(() => {
    return () => {
      dashboardRequestId.current += 1;
      localApiRequestId.current += 1;
      localMetricsRequestId.current += 1;
      dashboardAbortController.current?.abort();
      localApiAbortController.current?.abort();
      modelInstallAbortController.current?.abort();
      modelTestAbortController.current?.abort();
      localMetricsAbortController.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (localModels.length === 0) {
      setSelectedModelId(undefined);
      return;
    }

    if (!localModels.some((model) => model.id === selectedModelId)) {
      setSelectedModelId(localModels[0].id);
    }
  }, [localModels, selectedModelId]);

  const runModelTest = useCallback(
    async (modelId: string) => {
      modelTestAbortController.current?.abort();
      const abortController = new AbortController();
      modelTestAbortController.current = abortController;
      setModelTestState("running");
      setModelTestOutput(undefined);
      setModelTestError(undefined);

      try {
        const completion = await createLocalChatCompletion(
          localApiUrl,
          modelId,
          "Reply with exactly: OpenModel is ready",
          abortController.signal,
        );
        const output = completion.choices[0]?.message?.content?.trim();
        setModelTestOutput(output || "The model returned an empty response.");
        setModelTestState("complete");
        await refreshLocalModelsSilently(localApiUrl);
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }
        setModelTestError(
          error instanceof Error
            ? error.message
            : "The local inference test failed.",
        );
        setModelTestState("error");
        await refreshLocalModelsSilently(localApiUrl);
      }
    },
    [localApiUrl, refreshLocalModelsSilently],
  );

  useEffect(() => {
    modelTestAbortController.current?.abort();
    setModelTestState("idle");
    setModelTestOutput(undefined);
    setModelTestError(undefined);
  }, [selectedModelId]);

  const copyCommand = useCallback(async (commandId: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedCommand(commandId);
    window.setTimeout(() => {
      setCopiedCommand((currentCommandId) =>
        currentCommandId === commandId ? undefined : currentCommandId,
      );
    }, 1600);
  }, []);

  if (!session && activeRoute === "metrics") {
    return (
      <PublicLocalMetricsPage
        localApiInput={localApiInput}
        localApiState={localApiState}
        localApiError={localApiError}
        localMetrics={localMetrics}
        localMetricsError={localMetricsError}
        localMetricsLoading={localMetricsLoading}
        localMetricsResetting={localMetricsResetting}
        onLocalApiInputChange={setLocalApiInput}
        onConnect={() => void loadLocalModelRegistry(localApiInput)}
        onRefresh={() => void loadLocalMetricsSnapshot(true)}
        onReset={() => void clearLocalMetrics()}
        onSignIn={onSignIn}
        onHome={navigateHome}
      />
    );
  }

  if (!session) {
    const configurationError = getAuthConfigurationError();
    return (
      <main className="bui-root dashboard-page dashboard-auth-gate" data-bui-theme={theme}>
        <button
          className="dashboard-auth-brand"
          type="button"
          onClick={navigateHome}
        >
          <span aria-hidden="true">OM</span>
          <span>OpenModel</span>
        </button>
        <Card className="dashboard-auth-panel">
          <div className="terminal-title">
            <span></span>
            <span></span>
            <span></span>
            <strong>DASHBOARD::ACCESS</strong>
          </div>
          <div className="dashboard-auth-content">
            <Badge>AUTHENTICATION REQUIRED</Badge>
            <h1>Sign in</h1>
            <p>
              Sign in through Amazon Cognito to load your account, token status,
              cloud gateway registry, and local model workspace.
            </p>
            {authenticationError || configurationError ? (
              <div className="dashboard-inline-error">
                {authenticationError ?? configurationError}
              </div>
            ) : null}
            <div className="hero-actions">
              <Button onClick={onSignIn}>Sign in with Cognito</Button>
              <Button
                variant="outline"
                onClick={() => navigateDashboard("metrics")}
              >
                View local metrics
              </Button>
              <Button variant="ghost" onClick={navigateHome}>
                Return home
              </Button>
            </div>
          </div>
        </Card>
      </main>
    );
  }

  const displayedName =
    dashboardUser?.name ??
    localUser?.name ??
    dashboardUser?.email ??
    localUser?.email ??
    dashboardUser?.username ??
    localUser?.username ??
    "OpenModel user";
  const displayedEmail = dashboardUser?.email ?? localUser?.email;
  const displayedGroups = dashboardUser?.groups ?? localUser?.groups ?? [];
  const displayedPermissions = dashboardUser?.permissions ?? [];
  const tokenExpiresAt = new Date(session.expiresAt);
  const apiConnected = Boolean(dashboardUser);
  const localApiConnected = localApiState === "connected";
  const selectedModel = localModels.find(
    (model) => model.id === selectedModelId,
  );
  const selectedModelRuntime = localRuntimeStatus?.models.find(
    (model) => model.id === selectedModel?.id,
  );
  const selectedModelRunnable = Boolean(selectedModelRuntime?.runnable);
  const preferredRuntimeId =
    selectedModelRuntime?.requiredRuntimeIds[0] ?? "llama.cpp";
  const preferredRuntime = localRuntimeStatus?.runtimes.find(
    (runtime) => runtime.id === preferredRuntimeId,
  );
  const runtimeInstallCommand =
    preferredRuntime?.installCommand ??
    (localRuntimeStatus?.platform === "win32"
      ? "winget install llama.cpp"
      : "brew install llama.cpp");
  const starterModel = localModelCatalog[0];
  const displayedStarterModel = starterModel ?? starterModelFallback;
  const starterInstalledModelId =
    starterModel?.installedModelId ??
    (modelInstallJob?.status === "completed"
      ? modelInstallJob.modelId
      : undefined);
  const starterModelInstalled = Boolean(
    starterModel?.installed ||
    (starterInstalledModelId &&
      localModels.some((model) => model.id === starterInstalledModelId)),
  );
  const modelInstallInProgress = Boolean(
    modelInstallJob && !["completed", "error"].includes(modelInstallJob.status),
  );
  const modelInstallProgress = Math.max(
    0,
    Math.min(100, Math.round(modelInstallJob?.progress ?? 0)),
  );
  const userInitials =
    displayedName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.slice(0, 1).toUpperCase())
      .join("") || "OM";
  const installCommand = "npm install -g @wundercorp/openmodel";
  const pullCommand = "om pull hf://owner/repo/model.gguf --alias local";
  const serveCommand = "om serve --port 11435";
  const runtimeVerifyCommand = "om doctor";
  const requestCommand = `curl ${localApiUrl}/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{"model":"${selectedModel?.id ?? "local"}","messages":[{"role":"user","content":"Hello"}]}'`;
  const activeLocalModelId =
    selectedModel?.id ?? localModels[0]?.id ?? modelInstallJob?.modelId;
  const activeLocalModelRuntime = localRuntimeStatus?.models.find(
    (model) => model.id === activeLocalModelId,
  );
  const activeLocalModelRunnable = Boolean(activeLocalModelRuntime?.runnable);
  const builderStudioProfileId = "openmodel-local";
  const builderStudioModelId = activeLocalModelId ?? "YOUR_MODEL_ID";
  const builderStudioBaseUrl = `${localApiUrl}/v1`;
  const builderStudioInstallCommand = "npm install -g @wundercorp/bs@latest";
  const builderStudioInitializeCommand = "bs init --skip-model-setup";
  const builderStudioImportCommand = `bs api POST /ai/providers/import --body-json '${JSON.stringify(
    {
      profileId: builderStudioProfileId,
      displayName: "OpenModel Local",
      providerKind: "custom-local",
      baseUrl: builderStudioBaseUrl,
      model: builderStudioModelId,
      local: true,
      enabled: true,
      defaultTemperature: 0.2,
      defaultMaxTokens: 2048,
    },
  )}'`;
  const builderStudioSelectCommand = `bs model use "${builderStudioModelId}" --profile ${builderStudioProfileId} --strict`;
  const builderStudioTestCommand = `bs model test ${builderStudioProfileId}`;
  const builderStudioAskCommand = `bs ask "Explain this repository and suggest the next useful change." --profile ${builderStudioProfileId} --model "${builderStudioModelId}" --strict`;
  const builderStudioCompleteSetupCommand = [
    builderStudioInstallCommand,
    "cd /path/to/your/project",
    builderStudioInitializeCommand,
    builderStudioImportCommand,
    builderStudioSelectCommand,
    builderStudioTestCommand,
  ].join("\n");
  const dokuInstallCommand = "npm install -g @wundercorp/doku@latest";
  const dokuGenerateCommand = "doku gen";
  const dokuPackCommand = "doku pack . --output doku.docs.json";
  const dokuOpenCommand = "doku open ./doku.docs.json --site https://doku.sh";
  const dokuRefreshCommand = "doku gen && doku pack . --output doku.docs.json";
  const dokuCompleteSetupCommand = [
    dokuInstallCommand,
    "cd /path/to/your/project",
    dokuGenerateCommand,
    dokuPackCommand,
    dokuOpenCommand,
  ].join("\n");
  const dokuPackageScripts = `{
  "scripts": {
    "docs:update": "doku gen && doku pack . --output doku.docs.json",
    "docs:open": "doku open ./doku.docs.json --site https://doku.sh"
  }
}`;
  const cloudStatus = apiConnected
    ? "ONLINE"
    : loadState === "loading"
      ? "CONNECTING"
      : "OFFLINE";
  const runnableModelCount =
    localRuntimeStatus?.models.filter((model) => model.runnable).length ?? 0;
  const localRuntimeRequired =
    localApiConnected && localModels.length > 0 && runnableModelCount === 0;
  const localStatusLabel =
    localApiState === "loading"
      ? "CONNECTING"
      : localApiConnected
        ? localRuntimeRequired
          ? "RUNTIME REQUIRED"
          : "CONNECTED"
        : localApiState === "offline"
          ? "OFFLINE"
          : "NOT CONNECTED";
  const activeRouteLabel =
    dashboardRouteItems.find((item) => item.route === activeRoute)?.label ??
    "Overview";
  const localInferenceMetrics = localMetrics?.inference;
  const localTotalTokens = localInferenceMetrics?.totalTokens ?? 0;
  const localPromptTokenShare =
    localTotalTokens > 0
      ? ((localInferenceMetrics?.promptTokens ?? 0) / localTotalTokens) * 100
      : 0;
  const localCompletionTokenShare =
    localTotalTokens > 0
      ? ((localInferenceMetrics?.completionTokens ?? 0) / localTotalTokens) *
        100
      : 0;
  const localInferenceSuccessRate =
    (localInferenceMetrics?.totalRequests ?? 0) > 0
      ? ((localInferenceMetrics?.successfulRequests ?? 0) /
          (localInferenceMetrics?.totalRequests ?? 1)) *
        100
      : 0;
  const cloudAverageLatencyMs =
    cloudMetrics.syncAttempts > 0
      ? cloudMetrics.totalLatencyMs / cloudMetrics.syncAttempts
      : 0;
  const cloudSyncSuccessRate =
    cloudMetrics.syncAttempts > 0
      ? (cloudMetrics.successfulSyncs / cloudMetrics.syncAttempts) * 100
      : 0;
  const sessionRemainingSeconds = Math.max(
    0,
    Math.floor((session.expiresAt - Date.now()) / 1000),
  );

  return (
    <main
      className={`bui-root dashboard-app-shell${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`}
      data-bui-theme={theme}
    >
      <aside
        className={`dashboard-sidebar${sidebarCollapsed ? " is-collapsed" : ""}`}
      >
        <div className="dashboard-sidebar-header">
          <button
            className="dashboard-sidebar-brand"
            type="button"
            onClick={navigateHome}
            title="Open OpenModel.sh"
          >
            <span className="dashboard-sidebar-brand-copy">
              <strong>OpenModel</strong>
              <small>Local control plane</small>
            </span>
          </button>

          <button
            className="dashboard-sidebar-collapse"
            type="button"
            aria-label={
              sidebarCollapsed
                ? "Expand dashboard navigation"
                : "Collapse dashboard navigation"
            }
            title={
              sidebarCollapsed ? "Expand navigation" : "Collapse navigation"
            }
            onClick={() => setSidebarCollapsed((currentValue) => !currentValue)}
          >
            <span aria-hidden="true">{sidebarCollapsed ? "›" : "‹"}</span>
          </button>
        </div>

        <nav className="dashboard-sidebar-nav" aria-label="Dashboard pages">
          {dashboardRouteItems.map((item) => (
            <button
              key={item.route}
              className={activeRoute === item.route ? "is-active" : undefined}
              type="button"
              aria-current={activeRoute === item.route ? "page" : undefined}
              title={sidebarCollapsed ? item.label : undefined}
              onClick={() => navigateDashboard(item.route)}
            >
              <span className="dashboard-nav-icon">
                <DashboardNavIcon route={item.route} />
              </span>
              <span className="dashboard-nav-label">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="dashboard-sidebar-spacer"></div>

        <div
          className="dashboard-sidebar-status"
          title={`LOCAL API: ${localStatusLabel} · ${localApiUrl}`}
        >
          <span>LOCAL API</span>
          <strong className={localApiConnected ? "is-online" : "is-offline"}>
            {localStatusLabel}
          </strong>
          <small>{localApiUrl}</small>
        </div>

        <div className="dashboard-sidebar-controls">
          <Button variant="outline" onClick={onThemeChange}>
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </Button>
        </div>
      </aside>

      <div className="dashboard-workspace">
        <header className="dashboard-topbar">
          <div className="dashboard-breadcrumb">
            <span>OpenModel</span>
            <span>/</span>
            <strong>{activeRouteLabel}</strong>
          </div>

          <div className="dashboard-profile-menu" ref={dashboardProfileMenuRef}>
            <button
              className="dashboard-profile-trigger"
              type="button"
              aria-haspopup="menu"
              aria-expanded={profileMenuOpen}
              onClick={() =>
                setProfileMenuOpen((currentValue) => !currentValue)
              }
            >
              <span className="dashboard-browser-session-status"></span>
              <span className="dashboard-profile-trigger-copy">
                <strong>{displayedName}</strong>
                <small>Browser session · Cognito</small>
              </span>
              <span className="dashboard-user-avatar dashboard-user-avatar-small">
                {userInitials}
              </span>
              <span className="dashboard-profile-caret" aria-hidden="true">
                {profileMenuOpen ? "▲" : "▼"}
              </span>
            </button>

            {profileMenuOpen ? (
              <div className="dashboard-profile-dropdown" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => navigateDashboard("account")}
                >
                  <span>01</span>
                  Account profile
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setProfileMenuOpen(false);
                    onSignOut();
                  }}
                >
                  <span>02</span>
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </header>

        <div className="dashboard-content">
          {activeRoute === "overview" ? (
            <section className="dashboard-section dashboard-overview dashboard-page-view">
              <div className="dashboard-page-heading">
                <div>
                  <Badge>AUTHENTICATED CONTROL PLANE</Badge>
                  <h1>Local inference workspace</h1>
                  <p>
                    Connect the browser to the OpenModel runtime on this
                    computer, select an installed model, and copy the API
                    request you need.
                  </p>
                </div>
                <div className="dashboard-page-actions">
                  <Button
                    variant="outline"
                    disabled={cloudRefreshing}
                    onClick={() => void loadDashboard()}
                  >
                    {cloudRefreshing ? "Syncing cloud" : "Refresh cloud"}
                  </Button>
                  <Button variant="ghost" onClick={navigateHome}>
                    View site
                  </Button>
                </div>
              </div>

              {dashboardError ? (
                <div className="authentication-notice authentication-notice-error dashboard-notice">
                  <span>API_WARNING</span>
                  <strong>{dashboardError}</strong>
                  <button type="button" onClick={() => void loadDashboard()}>
                    RETRY
                  </button>
                </div>
              ) : null}

              <div className="dashboard-status-grid dashboard-status-grid-four">
                <Card className="dashboard-status-card">
                  <span className="dashboard-status-label">
                    BROWSER SESSION
                  </span>
                  <strong>ACTIVE</strong>
                  <span className="dashboard-status-detail">
                    EXPIRES {tokenExpiresAt.toLocaleTimeString()}
                  </span>
                </Card>
                <Card className="dashboard-status-card">
                  <span className="dashboard-status-label">CLOUD API</span>
                  <strong>{cloudStatus}</strong>
                  <span className="dashboard-status-detail">
                    {cloudRefreshing
                      ? "SYNCING IN BACKGROUND"
                      : lastCloudSyncAt
                        ? `SYNCED ${new Date(lastCloudSyncAt).toLocaleTimeString()}`
                        : getApiBaseUrl()}
                  </span>
                </Card>
                <Card className="dashboard-status-card">
                  <span className="dashboard-status-label">GATEWAYS</span>
                  <strong>
                    {String(gatewayRecords.length).padStart(2, "0")}
                  </strong>
                  <span className="dashboard-status-detail">
                    AVAILABLE SOURCES
                  </span>
                </Card>
                <Card className="dashboard-status-card">
                  <span className="dashboard-status-label">LOCAL MODELS</span>
                  <strong>{String(localModels.length).padStart(2, "0")}</strong>
                  <span className="dashboard-status-detail">
                    {localStatusLabel}
                  </span>
                </Card>
              </div>

              <div className="dashboard-overview-actions">
                <Card className="dashboard-overview-action-card">
                  <span className="dashboard-panel-kicker">NEXT ACTION</span>
                  <h3>
                    {localApiConnected
                      ? localRuntimeRequired
                        ? "INSTALL THE LOCAL INFERENCE RUNTIME"
                        : localModels.length > 0
                          ? "SELECT A MODEL AND SEND A REQUEST"
                          : "INSTALL YOUR FIRST LOCAL MODEL"
                      : "CONNECT YOUR LOCAL OPENMODEL SERVICE"}
                  </h3>
                  <p>
                    {localApiConnected
                      ? localRuntimeRequired
                        ? `Your model file is installed, but ${preferredRuntimeId} is still required before chat requests can run.`
                        : localModels.length > 0
                          ? "The local service and model runtime are ready. Open Models to run a test or copy a request."
                          : "The local service is online. Open Models, then install the recommended starter model with one click."
                      : "Start om serve once, then Open Models and install the recommended starter model directly from the dashboard."}
                  </p>
                  <Button onClick={() => navigateDashboard("models")}>
                    Open models
                  </Button>
                </Card>

                <Card className="dashboard-overview-action-card">
                  <span className="dashboard-panel-kicker">
                    LOCAL AI WORKFLOW
                  </span>
                  <h3>Use your model in BuilderStudio</h3>
                  <p>
                    Generate the exact local provider configuration for the
                    model selected on this computer, then start asking questions
                    or making code changes from your project directory.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => navigateResourceTab("builderstudio")}
                  >
                    Open model workflow
                  </Button>
                </Card>

                <Card className="dashboard-overview-action-card">
                  <span className="dashboard-panel-kicker">DOCUMENTATION</span>
                  <h3>Generate project docs with Doku.sh</h3>
                  <p>
                    Create docs.json, llms-full.txt, and a packed documentation
                    portal while your project evolves.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => navigateResourceTab("doku")}
                  >
                    Open Doku workflow
                  </Button>
                </Card>

                <Card className="dashboard-overview-action-card">
                  <span className="dashboard-panel-kicker">OBSERVABILITY</span>
                  <h3>Track tokens, latency, and inference</h3>
                  <p>
                    Review local token estimates, request success, latency,
                    throughput, per-model activity, and cloud control-plane
                    health.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => navigateDashboard("metrics")}
                  >
                    Open metrics
                  </Button>
                </Card>

                <Card className="dashboard-overview-action-card">
                  <span className="dashboard-panel-kicker">CLOUD REGISTRY</span>
                  <h3>{gatewayRecords.length} GATEWAYS AVAILABLE</h3>
                  <p>
                    Review supported URI schemes and capabilities before
                    choosing the source for your next model pull.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => navigateDashboard("gateways")}
                  >
                    View gateways
                  </Button>
                </Card>
              </div>
            </section>
          ) : null}

          {activeRoute === "models" ? (
            <section className="dashboard-section dashboard-page-view">
              <div className="dashboard-section-header">
                <div>
                  <span className="dashboard-section-index">02</span>
                  <Badge>LOCAL MODEL LIBRARY</Badge>
                  <h2>Install and run a model</h2>
                  <p>
                    Start the local OpenModel service once. After that, the
                    dashboard can download a recommended model directly to this
                    computer and show live progress.
                  </p>
                </div>
                <span
                  className={`dashboard-connection-state dashboard-connection-${localApiState}`}
                >
                  {localStatusLabel}
                </span>
              </div>

              <Card className="dashboard-local-api-panel">
                <form
                  className="dashboard-local-api-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void loadLocalModelRegistry(localApiInput);
                  }}
                >
                  <label htmlFor="local-api-url">LOCAL SERVICE</label>
                  <input
                    id="local-api-url"
                    type="url"
                    value={localApiInput}
                    onChange={(event) => setLocalApiInput(event.target.value)}
                    spellCheck={false}
                  />
                  <Button type="submit" disabled={localApiState === "loading"}>
                    {localApiState === "loading"
                      ? "CONNECTING"
                      : localApiConnected
                        ? "REFRESH"
                        : "CONNECT"}
                  </Button>
                  {localApiConnected ? (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={disconnectLocalApi}
                    >
                      DISCONNECT
                    </Button>
                  ) : null}
                </form>
                {localApiError ? (
                  <p className="dashboard-local-api-error">
                    Start <code>om serve --port 11435</code>, keep that terminal
                    open, and try again. <span>{localApiError}</span>
                  </p>
                ) : (
                  <p className="dashboard-local-api-help">
                    The local service performs the download. Model files never
                    pass through OpenModel.sh.
                  </p>
                )}
              </Card>

              {localRuntimeRequired ? (
                <div className="dashboard-runtime-banner" role="status">
                  <div>
                    <span>MODEL FILES::READY</span>
                    <strong>INFERENCE RUNTIME REQUIRED</strong>
                    <p>
                      The model is downloaded, but this computer still needs
                      {` ${preferredRuntimeId} `}to execute it.
                    </p>
                  </div>
                  <code>{runtimeInstallCommand}</code>
                  <button
                    type="button"
                    onClick={() =>
                      void copyCommand(
                        "runtime-install-banner",
                        runtimeInstallCommand,
                      )
                    }
                  >
                    {copiedCommand === "runtime-install-banner"
                      ? "COPIED"
                      : "COPY INSTALL COMMAND"}
                  </button>
                </div>
              ) : null}

              {localRuntimeError ? (
                <div
                  className="dashboard-runtime-banner dashboard-runtime-banner-warning"
                  role="status"
                >
                  <div>
                    <span>LOCAL CLI::UPDATE REQUIRED</span>
                    <strong>RUNTIME DETECTION IS UNAVAILABLE</strong>
                    <p>{localRuntimeError}</p>
                  </div>
                  <code>npm install -g @wundercorp/openmodel@latest</code>
                  <button
                    type="button"
                    onClick={() =>
                      void copyCommand(
                        "runtime-cli-update",
                        "npm install -g @wundercorp/openmodel@latest",
                      )
                    }
                  >
                    {copiedCommand === "runtime-cli-update"
                      ? "COPIED"
                      : "COPY UPDATE COMMAND"}
                  </button>
                </div>
              ) : null}

              <Card
                className={`dashboard-model-installer ${starterModelInstalled ? "is-installed" : ""}`}
              >
                <div className="dashboard-model-installer-main">
                  <div
                    className="dashboard-model-installer-status"
                    aria-hidden="true"
                  >
                    {starterModelInstalled
                      ? "✓"
                      : modelInstallInProgress
                        ? ">_"
                        : "↓"}
                  </div>
                  <div className="dashboard-model-installer-copy">
                    <span className="dashboard-panel-kicker">
                      {starterModelInstalled
                        ? "INSTALL::COMPLETE"
                        : modelInstallInProgress
                          ? "DOWNLOAD::ACTIVE"
                          : "RECOMMENDED STARTER"}
                    </span>
                    <h3>{displayedStarterModel.name}</h3>
                    <p>{displayedStarterModel.description}</p>
                    <div className="dashboard-model-specs">
                      <span>{displayedStarterModel.parameterCount}</span>
                      <span>{displayedStarterModel.format}</span>
                      <span>
                        {formatBytes(displayedStarterModel.sizeBytes)}
                      </span>
                      <span>{displayedStarterModel.license}</span>
                    </div>
                  </div>
                  <div className="dashboard-model-installer-action">
                    {starterModelInstalled ? (
                      <Button
                        onClick={() => {
                          if (starterInstalledModelId) {
                            setSelectedModelId(starterInstalledModelId);
                          }
                        }}
                      >
                        ✓ INSTALLED
                      </Button>
                    ) : (
                      <Button
                        disabled={modelInstallInProgress}
                        onClick={() =>
                          void installCatalogModel(displayedStarterModel.id)
                        }
                      >
                        {modelInstallInProgress
                          ? `DOWNLOADING ${modelInstallProgress}%`
                          : "INSTALL TO THIS MACHINE"}
                      </Button>
                    )}
                    <small>
                      {localApiConnected
                        ? "ONE CLICK · SAVED LOCALLY"
                        : "CONNECTS TO LOCAL SERVICE FIRST"}
                    </small>
                  </div>
                </div>

                {modelInstallJob ? (
                  <div className="dashboard-model-progress" aria-live="polite">
                    <div className="dashboard-model-progress-heading">
                      <span>{modelInstallJob.message}</span>
                      <strong>{modelInstallProgress}%</strong>
                    </div>
                    <div
                      className="dashboard-model-progress-track"
                      role="progressbar"
                      aria-label="Model download progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={modelInstallProgress}
                    >
                      <span
                        style={{ width: `${modelInstallProgress}%` }}
                      ></span>
                    </div>
                    <div className="dashboard-model-progress-meta">
                      <span>{modelInstallJob.stage.toUpperCase()}</span>
                      <span>
                        {formatBytes(modelInstallJob.downloadedBytes)} /{" "}
                        {formatBytes(
                          modelInstallJob.totalBytes ??
                            displayedStarterModel.sizeBytes,
                        )}
                      </span>
                      {modelInstallJob.fileName ? (
                        <code>{modelInstallJob.fileName}</code>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {modelInstallError ? (
                  <div className="dashboard-model-install-error">
                    <strong>INSTALLATION NEEDS ATTENTION</strong>
                    <span>{modelInstallError}</span>
                  </div>
                ) : null}

                {!localApiConnected ? (
                  <div className="dashboard-model-service-step">
                    <div>
                      <span>ONE-TIME SETUP</span>
                      <strong>START THE LOCAL OPENMODEL SERVICE</strong>
                    </div>
                    <code>om serve --port 11435</code>
                    <button
                      type="button"
                      onClick={() =>
                        void copyCommand(
                          "serve-service",
                          "om serve --port 11435",
                        )
                      }
                    >
                      {copiedCommand === "serve-service" ? "COPIED" : "COPY"}
                    </button>
                  </div>
                ) : null}
              </Card>

              <div className="dashboard-model-library-heading">
                <div>
                  <span className="dashboard-panel-kicker">LOCAL REGISTRY</span>
                  <h3>Installed models</h3>
                </div>
                <strong>{String(localModels.length).padStart(2, "0")}</strong>
              </div>

              {localModels.length > 0 ? (
                <Card className="dashboard-registry-panel dashboard-model-registry-panel">
                  <div className="dashboard-model-table-header">
                    <span>MODEL ID</span>
                    <span>GATEWAY</span>
                    <span>STATE</span>
                    <span>ACTION</span>
                  </div>
                  {localModels.map((model) => (
                    <div
                      className={`dashboard-model-table-row ${
                        model.id === selectedModelId ? "is-selected" : ""
                      }`}
                      key={model.id}
                    >
                      <code>{model.id}</code>
                      <span>{model.owned_by ?? "local"}</span>
                      <strong
                        className={
                          localRuntimeStatus?.models.find(
                            (runtimeModel) => runtimeModel.id === model.id,
                          )?.runnable
                            ? "is-ready"
                            : "is-warning"
                        }
                      >
                        {localRuntimeStatus?.models.find(
                          (runtimeModel) => runtimeModel.id === model.id,
                        )?.runnable
                          ? "✓ READY"
                          : "RUNTIME REQUIRED"}
                      </strong>
                      <button
                        type="button"
                        onClick={() => setSelectedModelId(model.id)}
                      >
                        {model.id === selectedModelId
                          ? "SELECTED"
                          : "USE MODEL"}
                      </button>
                    </div>
                  ))}
                </Card>
              ) : (
                <Card className="dashboard-empty-models dashboard-empty-models-compact">
                  <div
                    className="dashboard-empty-models-symbol"
                    aria-hidden="true"
                  >
                    [ ]
                  </div>
                  <div>
                    <span className="dashboard-panel-kicker">
                      REGISTRY::EMPTY
                    </span>
                    <h3>No local models yet</h3>
                    <p>
                      Use the Install button above. The model will appear here
                      automatically when the download completes.
                    </p>
                  </div>
                </Card>
              )}

              {selectedModel ? (
                selectedModelRunnable ? (
                  <div className="dashboard-next-step-layout">
                    <Card className="dashboard-next-step-panel">
                      <div className="dashboard-panel-heading">
                        <div>
                          <span className="dashboard-panel-kicker">
                            INFERENCE::READY
                          </span>
                          <h3>{selectedModel.id}</h3>
                        </div>
                        <span className="dashboard-online-indicator">
                          {selectedModelRuntime?.availableRuntimeId?.toUpperCase() ??
                            "READY"}
                        </span>
                      </div>

                      <div className="dashboard-model-test-panel">
                        <div>
                          <span>RUN A LOCAL CHECK</span>
                          <strong>
                            Send a short prompt through the OpenAI-compatible
                            endpoint.
                          </strong>
                          <small>
                            The first response loads the model into memory and
                            can take a little while. The test now runs as a
                            single turn and exits automatically.
                          </small>
                        </div>
                        <Button
                          disabled={modelTestState === "running"}
                          onClick={() => void runModelTest(selectedModel.id)}
                        >
                          {modelTestState === "running"
                            ? "LOADING MODEL..."
                            : modelTestState === "complete"
                              ? "✓ TEST PASSED"
                              : "RUN HELLO TEST"}
                        </Button>
                      </div>

                      {modelTestOutput ? (
                        <div
                          className="dashboard-model-test-result"
                          aria-live="polite"
                        >
                          <span>MODEL RESPONSE</span>
                          <pre>{modelTestOutput}</pre>
                        </div>
                      ) : null}

                      {modelTestError ? (
                        <div
                          className="dashboard-model-install-error"
                          aria-live="polite"
                        >
                          <strong>INFERENCE TEST FAILED</strong>
                          <span>{modelTestError}</span>
                        </div>
                      ) : null}

                      <div className="dashboard-command-list">
                        <DashboardCommand
                          index="01"
                          title="KEEP THE LOCAL SERVICE RUNNING"
                          command={serveCommand}
                          copied={copiedCommand === "serve-selected"}
                          onCopy={() =>
                            void copyCommand("serve-selected", serveCommand)
                          }
                        />
                        <DashboardCommand
                          index="02"
                          title="SEND A CHAT REQUEST"
                          command={requestCommand}
                          copied={copiedCommand === "request"}
                          onCopy={() =>
                            void copyCommand("request", requestCommand)
                          }
                        />
                      </div>
                    </Card>

                    <Card className="dashboard-context-panel">
                      <span className="dashboard-panel-kicker">
                        CONNECTION DETAILS
                      </span>
                      <h3>Use it from existing tools</h3>
                      <p>
                        The model file and inference runtime are both ready.
                        Point an OpenAI-compatible client at the local API.
                      </p>
                      <dl>
                        <div>
                          <dt>RUNTIME</dt>
                          <dd>
                            {selectedModelRuntime?.availableRuntimeId ??
                              "local"}
                          </dd>
                        </div>
                        <div>
                          <dt>OPENAI BASE URL</dt>
                          <dd>{localApiUrl}/v1</dd>
                        </div>
                        <div>
                          <dt>OLLAMA-COMPATIBLE URL</dt>
                          <dd>{localApiUrl}/api</dd>
                        </div>
                        <div>
                          <dt>SELECTED MODEL</dt>
                          <dd>{selectedModel.id}</dd>
                        </div>
                      </dl>
                      <Button
                        className="dashboard-context-action"
                        onClick={() => navigateResourceTab("builderstudio")}
                      >
                        USE WITH BUILDERSTUDIO
                      </Button>
                    </Card>
                  </div>
                ) : (
                  <div className="dashboard-next-step-layout">
                    <Card className="dashboard-runtime-required-panel">
                      <div className="dashboard-panel-heading">
                        <div>
                          <span className="dashboard-panel-kicker">
                            NEXT: ENABLE INFERENCE
                          </span>
                          <h3>
                            {localRuntimeError
                              ? "UPDATE THE LOCAL CLI"
                              : `INSTALL ${preferredRuntimeId.toUpperCase()}`}
                          </h3>
                        </div>
                        <span className="dashboard-runtime-missing-indicator">
                          RUNTIME MISSING
                        </span>
                      </div>
                      <p>
                        Your model download is complete. OpenModel still needs a
                        compatible local inference engine before chat requests
                        can run.
                      </p>
                      <div className="dashboard-command-list">
                        <DashboardCommand
                          index="01"
                          title={
                            localRuntimeError
                              ? "UPDATE OPENMODEL"
                              : "INSTALL THE RUNTIME"
                          }
                          command={
                            localRuntimeError
                              ? "npm install -g @wundercorp/openmodel@latest"
                              : runtimeInstallCommand
                          }
                          copied={copiedCommand === "runtime-install"}
                          onCopy={() =>
                            void copyCommand(
                              "runtime-install",
                              localRuntimeError
                                ? "npm install -g @wundercorp/openmodel@latest"
                                : runtimeInstallCommand,
                            )
                          }
                        />
                        <DashboardCommand
                          index="02"
                          title="VERIFY OPENMODEL CAN SEE IT"
                          command={runtimeVerifyCommand}
                          copied={copiedCommand === "runtime-verify"}
                          onCopy={() =>
                            void copyCommand(
                              "runtime-verify",
                              runtimeVerifyCommand,
                            )
                          }
                        />
                      </div>
                      <div className="dashboard-runtime-actions">
                        <Button
                          disabled={localApiState === "loading"}
                          onClick={() =>
                            void loadLocalModelRegistry(localApiUrl)
                          }
                        >
                          {localApiState === "loading"
                            ? "CHECKING"
                            : "RECHECK RUNTIME"}
                        </Button>
                        <span>
                          Restart <code>om serve</code> only if the runtime is
                          still not detected after installation.
                        </span>
                      </div>
                    </Card>

                    <Card className="dashboard-context-panel dashboard-runtime-context-panel">
                      <span className="dashboard-panel-kicker">
                        MODEL STATUS
                      </span>
                      <h3>Downloaded is not yet runnable</h3>
                      <p>
                        OpenModel separates model storage from execution. The
                        GGUF file is safely installed; {preferredRuntimeId}{" "}
                        supplies the native inference binary that reads it.
                      </p>
                      <dl>
                        <div>
                          <dt>MODEL FILE</dt>
                          <dd>✓ INSTALLED</dd>
                        </div>
                        <div>
                          <dt>REQUIRED RUNTIME</dt>
                          <dd>{preferredRuntimeId}</dd>
                        </div>
                        <div>
                          <dt>PLATFORM</dt>
                          <dd>
                            {localRuntimeStatus
                              ? `${localRuntimeStatus.platform} / ${localRuntimeStatus.architecture}`
                              : "UNKNOWN"}
                          </dd>
                        </div>
                        <div>
                          <dt>CHAT API</dt>
                          <dd>BLOCKED UNTIL RUNTIME IS READY</dd>
                        </div>
                      </dl>
                    </Card>
                  </div>
                )
              ) : null}
            </section>
          ) : null}

          {activeRoute === "resources" ? (
            <div
              className="dashboard-metrics-tabs dashboard-resource-tabs"
              role="tablist"
              aria-label="Resources"
            >
              <button
                className={
                  activeResourceTab === "builderstudio"
                    ? "is-active"
                    : undefined
                }
                type="button"
                role="tab"
                aria-selected={activeResourceTab === "builderstudio"}
                onClick={() => navigateResourceTab("builderstudio")}
              >
                <span>01</span>
                <strong>BUILDERSTUDIO / BS CLI</strong>
                <small>Local model workflows</small>
              </button>
              <button
                className={
                  activeResourceTab === "doku" ? "is-active" : undefined
                }
                type="button"
                role="tab"
                aria-selected={activeResourceTab === "doku"}
                onClick={() => navigateResourceTab("doku")}
              >
                <span>02</span>
                <strong>DOKU.SH</strong>
                <small>Documentation automation</small>
              </button>
            </div>
          ) : null}

          {activeRoute === "resources" &&
          activeResourceTab === "builderstudio" ? (
            <section className="dashboard-section dashboard-page-view">
              <div className="dashboard-section-header">
                <div>
                  <span className="dashboard-section-index">03</span>
                  <Badge>LOCAL AI TOOLING</Badge>
                  <h2>Use your model with BuilderStudio</h2>
                  <p>
                    Connect BuilderStudio to the OpenAI-compatible API already
                    running on this computer. No model files leave your machine.
                  </p>
                </div>
                <div className="dashboard-page-actions">
                  <a
                    className="button button-outline"
                    href="https://www.npmjs.com/package/@wundercorp/bs"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    VIEW NPM PACKAGE
                  </a>
                  <Button
                    variant="ghost"
                    onClick={() => navigateDashboard("models")}
                  >
                    MANAGE MODELS
                  </Button>
                </div>
              </div>

              <Card className="dashboard-tool-readiness">
                <div className="dashboard-tool-readiness-status">
                  <span
                    className={`dashboard-tool-status-dot ${
                      localApiConnected && activeLocalModelRunnable
                        ? "is-ready"
                        : ""
                    }`}
                  ></span>
                  <div>
                    <span className="dashboard-panel-kicker">
                      LOCAL MODEL STATUS
                    </span>
                    <strong>
                      {!localApiConnected
                        ? "CONNECT THE LOCAL SERVICE"
                        : !activeLocalModelId
                          ? "INSTALL OR SELECT A MODEL"
                          : activeLocalModelRunnable
                            ? "READY FOR BUILDERSTUDIO"
                            : "INSTALL THE MODEL RUNTIME"}
                    </strong>
                  </div>
                </div>

                <div className="dashboard-tool-readiness-actions">
                  {!localApiConnected ? (
                    <Button
                      disabled={localApiState === "loading"}
                      onClick={() => void loadLocalModelRegistry(localApiInput)}
                    >
                      {localApiState === "loading"
                        ? "CONNECTING"
                        : "CONNECT LOCAL API"}
                    </Button>
                  ) : localModels.length === 0 ? (
                    <Button onClick={() => navigateDashboard("models")}>
                      INSTALL A MODEL
                    </Button>
                  ) : !activeLocalModelRunnable ? (
                    <Button onClick={() => navigateDashboard("models")}>
                      FIX MODEL RUNTIME
                    </Button>
                  ) : (
                    <label className="dashboard-tool-model-select">
                      <span>MODEL</span>
                      <select
                        value={activeLocalModelId}
                        onChange={(event) =>
                          setSelectedModelId(event.target.value)
                        }
                      >
                        {localModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.id}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              </Card>

              <div className="dashboard-tool-grid">
                <Card className="dashboard-next-step-panel dashboard-tool-setup-panel">
                  <div className="dashboard-panel-heading">
                    <div>
                      <span className="dashboard-panel-kicker">
                        QUICK SETUP
                      </span>
                      <h3>Connect the current project</h3>
                    </div>
                    <button
                      className="dashboard-copy-all-button"
                      type="button"
                      disabled={!activeLocalModelRunnable}
                      onClick={() =>
                        void copyCommand(
                          "builderstudio-all",
                          builderStudioCompleteSetupCommand,
                        )
                      }
                    >
                      {copiedCommand === "builderstudio-all"
                        ? "COPIED"
                        : "COPY COMPLETE SETUP"}
                    </button>
                  </div>

                  {!activeLocalModelId || !activeLocalModelRunnable ? (
                    <div className="dashboard-tool-inline-notice">
                      {!activeLocalModelId
                        ? "Connect the local service and select an installed model to generate the final commands."
                        : "The model is installed, but BuilderStudio requests will fail until its local inference runtime is available. Open Models to finish runtime setup."}
                    </div>
                  ) : null}

                  <div className="dashboard-command-list">
                    <DashboardCommand
                      index="01"
                      title="INSTALL BUILDERSTUDIO"
                      command={builderStudioInstallCommand}
                      copied={copiedCommand === "builderstudio-install"}
                      onCopy={() =>
                        void copyCommand(
                          "builderstudio-install",
                          builderStudioInstallCommand,
                        )
                      }
                    />
                    <DashboardCommand
                      index="02"
                      title="INITIALIZE THIS PROJECT"
                      command={`cd /path/to/your/project
${builderStudioInitializeCommand}`}
                      copied={copiedCommand === "builderstudio-init"}
                      onCopy={() =>
                        void copyCommand(
                          "builderstudio-init",
                          `cd /path/to/your/project
${builderStudioInitializeCommand}`,
                        )
                      }
                    />
                    <DashboardCommand
                      index="03"
                      title="REGISTER OPENMODEL"
                      command={builderStudioImportCommand}
                      copied={copiedCommand === "builderstudio-import"}
                      onCopy={() =>
                        void copyCommand(
                          "builderstudio-import",
                          builderStudioImportCommand,
                        )
                      }
                    />
                    <DashboardCommand
                      index="04"
                      title="MAKE IT THE DEFAULT MODEL"
                      command={builderStudioSelectCommand}
                      copied={copiedCommand === "builderstudio-select"}
                      onCopy={() =>
                        void copyCommand(
                          "builderstudio-select",
                          builderStudioSelectCommand,
                        )
                      }
                    />
                    <DashboardCommand
                      index="05"
                      title="VERIFY THE CONNECTION"
                      command={builderStudioTestCommand}
                      copied={copiedCommand === "builderstudio-test"}
                      onCopy={() =>
                        void copyCommand(
                          "builderstudio-test",
                          builderStudioTestCommand,
                        )
                      }
                    />
                  </div>
                </Card>

                <div className="dashboard-tool-side-column">
                  <Card className="dashboard-context-panel dashboard-tool-summary">
                    <span className="dashboard-panel-kicker">
                      ACTIVE CONFIGURATION
                    </span>
                    <h3>OpenModel local</h3>
                    <p>
                      BuilderStudio sends OpenAI-compatible chat completion
                      requests directly to your local OpenModel service.
                    </p>
                    <dl>
                      <div>
                        <dt>PROFILE</dt>
                        <dd>{builderStudioProfileId}</dd>
                      </div>
                      <div>
                        <dt>BASE URL</dt>
                        <dd>{builderStudioBaseUrl}</dd>
                      </div>
                      <div>
                        <dt>MODEL</dt>
                        <dd>{builderStudioModelId}</dd>
                      </div>
                      <div>
                        <dt>ROUTING</dt>
                        <dd>STRICT · NO FALLBACKS</dd>
                      </div>
                    </dl>
                  </Card>

                  <Card className="dashboard-next-step-panel dashboard-tool-try-panel">
                    <div className="dashboard-panel-heading">
                      <div>
                        <span className="dashboard-panel-kicker">TRY IT</span>
                        <h3>Ask about your project</h3>
                      </div>
                    </div>
                    <DashboardCommand
                      index="$"
                      title="WORKSPACE-AWARE QUESTION"
                      command={builderStudioAskCommand}
                      copied={copiedCommand === "builderstudio-ask"}
                      onCopy={() =>
                        void copyCommand(
                          "builderstudio-ask",
                          builderStudioAskCommand,
                        )
                      }
                    />
                  </Card>
                </div>
              </div>
            </section>
          ) : null}

          {activeRoute === "resources" && activeResourceTab === "doku" ? (
            <section className="dashboard-section dashboard-page-view">
              <div className="dashboard-section-header">
                <div>
                  <span className="dashboard-section-index">03</span>
                  <Badge>DOCUMENTATION WORKFLOW</Badge>
                  <h2>Generate docs as you build</h2>
                  <p>
                    Doku creates project metadata, an LLM-readable documentation
                    file, and a packed portal you can open on doku.sh.
                  </p>
                </div>
                <div className="dashboard-page-actions">
                  <a
                    className="button"
                    href="https://doku.sh"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    OPEN DOKU.SH
                  </a>
                  <a
                    className="button button-outline"
                    href="https://www.npmjs.com/package/@wundercorp/doku"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    VIEW NPM PACKAGE
                  </a>
                </div>
              </div>

              <div className="dashboard-tool-grid">
                <Card className="dashboard-next-step-panel dashboard-tool-setup-panel">
                  <div className="dashboard-panel-heading">
                    <div>
                      <span className="dashboard-panel-kicker">FAST PATH</span>
                      <h3>Create and open your docs</h3>
                    </div>
                    <button
                      className="dashboard-copy-all-button"
                      type="button"
                      onClick={() =>
                        void copyCommand("doku-all", dokuCompleteSetupCommand)
                      }
                    >
                      {copiedCommand === "doku-all"
                        ? "COPIED"
                        : "COPY COMPLETE SETUP"}
                    </button>
                  </div>

                  <div className="dashboard-command-list">
                    <DashboardCommand
                      index="01"
                      title="INSTALL DOKU"
                      command={dokuInstallCommand}
                      copied={copiedCommand === "doku-install"}
                      onCopy={() =>
                        void copyCommand("doku-install", dokuInstallCommand)
                      }
                    />
                    <DashboardCommand
                      index="02"
                      title="GENERATE PROJECT DOCS"
                      command={`cd /path/to/your/project
${dokuGenerateCommand}`}
                      copied={copiedCommand === "doku-generate"}
                      onCopy={() =>
                        void copyCommand(
                          "doku-generate",
                          `cd /path/to/your/project
${dokuGenerateCommand}`,
                        )
                      }
                    />
                    <DashboardCommand
                      index="03"
                      title="PACK THE PORTAL"
                      command={dokuPackCommand}
                      copied={copiedCommand === "doku-pack"}
                      onCopy={() =>
                        void copyCommand("doku-pack", dokuPackCommand)
                      }
                    />
                    <DashboardCommand
                      index="04"
                      title="OPEN IT ON DOKU.SH"
                      command={dokuOpenCommand}
                      copied={copiedCommand === "doku-open"}
                      onCopy={() =>
                        void copyCommand("doku-open", dokuOpenCommand)
                      }
                    />
                  </div>
                </Card>

                <div className="dashboard-tool-side-column">
                  <Card className="dashboard-context-panel dashboard-tool-summary">
                    <span className="dashboard-panel-kicker">
                      GENERATED OUTPUT
                    </span>
                    <h3>Files Doku creates</h3>
                    <div className="dashboard-tool-file-list">
                      <div>
                        <code>docs.json</code>
                        <span>Navigation and documentation metadata.</span>
                      </div>
                      <div>
                        <code>llms-full.txt</code>
                        <span>LLM-readable project context and docs.</span>
                      </div>
                      <div>
                        <code>doku.docs.json</code>
                        <span>
                          Packed navigation and page content for the portal.
                        </span>
                      </div>
                    </div>
                  </Card>

                  <Card className="dashboard-next-step-panel dashboard-tool-try-panel">
                    <div className="dashboard-panel-heading">
                      <div>
                        <span className="dashboard-panel-kicker">
                          ONGOING WORKFLOW
                        </span>
                        <h3>Refresh docs after changes</h3>
                      </div>
                    </div>
                    <DashboardCommand
                      index="$"
                      title="REGENERATE AND PACK"
                      command={dokuRefreshCommand}
                      copied={copiedCommand === "doku-refresh"}
                      onCopy={() =>
                        void copyCommand("doku-refresh", dokuRefreshCommand)
                      }
                    />
                  </Card>
                </div>
              </div>

              <Card className="dashboard-tool-package-script">
                <div className="dashboard-panel-heading">
                  <div>
                    <span className="dashboard-panel-kicker">
                      OPTIONAL AUTOMATION
                    </span>
                    <h3>Add Doku to package.json</h3>
                  </div>
                  <button
                    className="dashboard-copy-all-button"
                    type="button"
                    onClick={() =>
                      void copyCommand(
                        "doku-package-scripts",
                        dokuPackageScripts,
                      )
                    }
                  >
                    {copiedCommand === "doku-package-scripts"
                      ? "COPIED"
                      : "COPY SCRIPTS"}
                  </button>
                </div>
                <CodeBlock>{dokuPackageScripts}</CodeBlock>
              </Card>
            </section>
          ) : null}

          {activeRoute === "metrics" ? (
            <>
              <div
                className="dashboard-metrics-tabs"
                role="tablist"
                aria-label="Metrics sections"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeMetricsTab === "overview"}
                  aria-controls="metrics-overview-panel"
                  className={activeMetricsTab === "overview" ? "is-active" : ""}
                  onClick={() => navigateMetricsTab("overview")}
                >
                  <span>01</span>
                  <strong>LOCAL USAGE</strong>
                  <small>Health and totals</small>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeMetricsTab === "performance"}
                  aria-controls="metrics-performance-panel"
                  className={
                    activeMetricsTab === "performance" ? "is-active" : ""
                  }
                  onClick={() => navigateMetricsTab("performance")}
                >
                  <span>02</span>
                  <strong>PERFORMANCE</strong>
                  <small>Latency and requests</small>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeMetricsTab === "external"}
                  aria-controls="metrics-external-panel"
                  className={activeMetricsTab === "external" ? "is-active" : ""}
                  onClick={() => navigateMetricsTab("external")}
                >
                  <span>03</span>
                  <strong>EXTERNAL USAGE</strong>
                  <small>Claude, Codex, and SDKs</small>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeMetricsTab === "pricing"}
                  aria-controls="metrics-pricing-panel"
                  className={activeMetricsTab === "pricing" ? "is-active" : ""}
                  onClick={() => navigateMetricsTab("pricing")}
                >
                  <span>04</span>
                  <strong>USAGE &amp; PRICING</strong>
                  <small>Allowance and cost</small>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeMetricsTab === "cloud"}
                  aria-controls="metrics-cloud-panel"
                  className={activeMetricsTab === "cloud" ? "is-active" : ""}
                  onClick={() => navigateMetricsTab("cloud")}
                >
                  <span>05</span>
                  <strong>CLOUD &amp; SYNC</strong>
                  <small>Session health</small>
                </button>
              </div>

              <section className="dashboard-section dashboard-page-view dashboard-metrics-page">
                <div className="dashboard-section-header">
                  <div>
                    <span className="dashboard-section-index">04</span>
                    <Badge>
                      {activeMetricsTab === "external"
                        ? "SESSION TELEMETRY"
                        : activeMetricsTab === "pricing"
                          ? "WUNDERSHIP PRICING"
                          : activeMetricsTab === "cloud"
                            ? "CONTROL PLANE"
                            : "LOCAL OBSERVABILITY"}
                    </Badge>
                    <h2>
                      {activeMetricsTab === "external"
                        ? "EXTERNAL TOKEN USAGE"
                        : activeMetricsTab === "pricing"
                          ? "USAGE AND COST"
                          : activeMetricsTab === "cloud"
                            ? "CLOUD AND SYNC"
                            : "LOCAL TOKENS AND INFERENCE"}
                    </h2>
                    <p>
                      {activeMetricsTab === "external"
                        ? "Capture token and cost metadata from Claude Code, Codex, OpenRouter, BuilderStudio, and custom SDKs through the local collector."
                        : activeMetricsTab === "pricing"
                          ? "Compare local and cloud-model usage, model-aware allowance consumption, provider rates, and synchronized billing estimates."
                          : activeMetricsTab === "cloud"
                            ? "Review browser authentication, cloud API synchronization, gateway registry health, and session timing."
                            : "Track local request volume, estimated token usage, latency, throughput, and model activity."}
                    </p>
                  </div>
                  {activeMetricsTab === "overview" ||
                  activeMetricsTab === "performance" ? (
                    <div className="dashboard-page-actions">
                      <Button
                        variant="outline"
                        disabled={!localApiConnected || localMetricsLoading}
                        onClick={() => void loadLocalMetricsSnapshot(true)}
                      >
                        {localMetricsLoading ? "SYNCING" : "REFRESH METRICS"}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={
                          !localApiConnected ||
                          !localMetrics ||
                          localMetricsResetting ||
                          (localInferenceMetrics?.activeRequests ?? 0) > 0
                        }
                        onClick={() => void clearLocalMetrics()}
                      >
                        {localMetricsResetting ? "RESETTING" : "RESET LOCAL"}
                      </Button>
                    </div>
                  ) : activeMetricsTab === "external" ? (
                    <div className="dashboard-page-actions">
                      <Button
                        variant="outline"
                        disabled={!localApiConnected || localMetricsLoading}
                        onClick={() => void loadLocalMetricsSnapshot(true)}
                      >
                        {localMetricsLoading
                          ? "REFRESHING"
                          : "REFRESH EXTERNAL"}
                      </Button>
                    </div>
                  ) : null}
                </div>

                {activeMetricsTab === "overview" ? (
                  <div
                    id="metrics-overview-panel"
                    className="dashboard-metrics-tab-panel"
                    role="tabpanel"
                    aria-label="Metrics overview"
                  >
                    <Card className="dashboard-metrics-privacy">
                      <span className="dashboard-metrics-privacy-mark">
                        🔒
                      </span>
                      <div>
                        <strong>METRICS STAY ON THIS COMPUTER</strong>
                        <p>
                          OpenModel stores counts and timing metadata in memory
                          only. Prompt and response content are not retained.
                          Token counts are estimates until a runtime supplies
                          exact usage data, and totals reset when
                          <code> om serve </code> restarts.
                        </p>
                      </div>
                    </Card>

                    {!localApiConnected ? (
                      <Card className="dashboard-metrics-connect-panel">
                        <div>
                          <span className="dashboard-panel-kicker">
                            LOCAL SERVICE REQUIRED
                          </span>
                          <h3>Connect to view inference metrics</h3>
                          <p>
                            Start <code>om serve --port 11435</code>, then
                            connect the dashboard to the local API. No
                            background connection is attempted.
                          </p>
                        </div>
                        <form
                          className="dashboard-local-api-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void loadLocalModelRegistry(localApiInput);
                          }}
                        >
                          <label htmlFor="metrics-local-api-url">
                            LOCAL SERVICE
                          </label>
                          <input
                            id="metrics-local-api-url"
                            value={localApiInput}
                            onChange={(event) =>
                              setLocalApiInput(event.target.value)
                            }
                            spellCheck={false}
                          />
                          <Button
                            disabled={localApiState === "loading"}
                            type="submit"
                          >
                            {localApiState === "loading"
                              ? "CONNECTING"
                              : "CONNECT"}
                          </Button>
                        </form>
                        {localApiError ? (
                          <p className="dashboard-local-api-error">
                            {localApiError}
                          </p>
                        ) : null}
                      </Card>
                    ) : localMetricsError && !localMetrics ? (
                      <Card className="dashboard-metrics-connect-panel dashboard-metrics-error-panel">
                        <div>
                          <span className="dashboard-panel-kicker">
                            METRICS UNAVAILABLE
                          </span>
                          <h3>Update the local OpenModel CLI</h3>
                          <p>{localMetricsError}</p>
                        </div>
                        <DashboardCommand
                          index="$"
                          title="UPDATE OPENMODEL"
                          command="npm install -g @wundercorp/openmodel@latest"
                          copied={copiedCommand === "metrics-update-cli"}
                          onCopy={() =>
                            void copyCommand(
                              "metrics-update-cli",
                              "npm install -g @wundercorp/openmodel@latest",
                            )
                          }
                        />
                      </Card>
                    ) : (
                      <>
                        {localMetricsError ? (
                          <div className="authentication-notice authentication-notice-error dashboard-notice">
                            <span>METRICS_WARNING</span>
                            <strong>{localMetricsError}</strong>
                            <button
                              type="button"
                              onClick={() =>
                                void loadLocalMetricsSnapshot(true)
                              }
                            >
                              RETRY
                            </button>
                          </div>
                        ) : null}
                        <div className="dashboard-metrics-grid">
                          <Card className="dashboard-metric-card">
                            <span>TOTAL TOKENS</span>
                            <strong>
                              {formatMetricNumber(localTotalTokens)}
                            </strong>
                            <small>ESTIMATED LOCAL USAGE</small>
                          </Card>
                          <Card className="dashboard-metric-card">
                            <span>REQUESTS</span>
                            <strong>
                              {formatMetricNumber(
                                localInferenceMetrics?.totalRequests,
                              )}
                            </strong>
                            <small>
                              {formatMetricNumber(
                                localInferenceMetrics?.activeRequests,
                              )}{" "}
                              ACTIVE
                            </small>
                          </Card>
                          <Card className="dashboard-metric-card">
                            <span>SUCCESS RATE</span>
                            <strong>
                              {formatPercent(localInferenceSuccessRate)}
                            </strong>
                            <small>
                              {formatMetricNumber(
                                localInferenceMetrics?.failedRequests,
                              )}{" "}
                              FAILED ·{" "}
                              {formatMetricNumber(
                                localInferenceMetrics?.cancelledRequests,
                              )}{" "}
                              CANCELLED
                            </small>
                          </Card>
                          <Card className="dashboard-metric-card">
                            <span>AVG LATENCY</span>
                            <strong>
                              {formatDuration(
                                localInferenceMetrics?.averageLatencyMs,
                              )}
                            </strong>
                            <small>
                              P50{" "}
                              {formatDuration(
                                localInferenceMetrics?.p50LatencyMs,
                              )}
                            </small>
                          </Card>
                          <Card className="dashboard-metric-card">
                            <span>P95 LATENCY</span>
                            <strong>
                              {formatDuration(
                                localInferenceMetrics?.p95LatencyMs,
                              )}
                            </strong>
                            <small>
                              MAX{" "}
                              {formatDuration(
                                localInferenceMetrics?.maxLatencyMs,
                              )}
                            </small>
                          </Card>
                          <Card className="dashboard-metric-card">
                            <span>COMPLETION SPEED</span>
                            <strong>
                              {formatMetricNumber(
                                localInferenceMetrics?.averageTokensPerSecond,
                              )}
                            </strong>
                            <small>EST. TOKENS / SECOND</small>
                          </Card>
                          <Card className="dashboard-metric-card">
                            <span>MODEL STORAGE</span>
                            <strong>
                              {formatBytes(localMetrics?.models.storageBytes)}
                            </strong>
                            <small>
                              {formatMetricNumber(
                                localMetrics?.models.installedCount,
                              )}{" "}
                              INSTALLED ·{" "}
                              {formatMetricNumber(
                                localMetrics?.models.runnableCount,
                              )}{" "}
                              RUNNABLE
                            </small>
                          </Card>
                          <Card className="dashboard-metric-card">
                            <span>METRICS WINDOW</span>
                            <strong>
                              {formatUptime(
                                localMetrics?.server.metricsUptimeSeconds,
                              )}
                            </strong>
                            <small>
                              SERVER UP{" "}
                              {formatUptime(localMetrics?.server.uptimeSeconds)}
                            </small>
                          </Card>
                        </div>
                      </>
                    )}
                  </div>
                ) : null}

                {activeMetricsTab === "performance" ? (
                  <div
                    id="metrics-performance-panel"
                    className="dashboard-metrics-tab-panel"
                    role="tabpanel"
                    aria-label="Local inference performance"
                  >
                    {!localApiConnected ? (
                      <Card className="dashboard-metrics-connect-panel">
                        <div>
                          <span className="dashboard-panel-kicker">
                            LOCAL SERVICE REQUIRED
                          </span>
                          <h3>Connect before viewing performance</h3>
                          <p>
                            Connect to <code>om serve</code> from Overview to
                            load latency, throughput, request history, and
                            per-model activity.
                          </p>
                        </div>
                        <Button
                          className="dashboard-metrics-connect-action"
                          onClick={() => navigateMetricsTab("overview")}
                        >
                          OPEN OVERVIEW
                        </Button>
                      </Card>
                    ) : localMetricsError && !localMetrics ? (
                      <Card className="dashboard-metrics-connect-panel dashboard-metrics-error-panel">
                        <div>
                          <span className="dashboard-panel-kicker">
                            METRICS UNAVAILABLE
                          </span>
                          <h3>Update the local OpenModel CLI</h3>
                          <p>{localMetricsError}</p>
                        </div>
                        <DashboardCommand
                          index="$"
                          title="UPDATE OPENMODEL"
                          command="npm install -g @wundercorp/openmodel@latest"
                          copied={copiedCommand === "metrics-update-cli"}
                          onCopy={() =>
                            void copyCommand(
                              "metrics-update-cli",
                              "npm install -g @wundercorp/openmodel@latest",
                            )
                          }
                        />
                      </Card>
                    ) : (
                      <>
                        {localMetricsError ? (
                          <div className="authentication-notice authentication-notice-error dashboard-notice">
                            <span>METRICS_WARNING</span>
                            <strong>{localMetricsError}</strong>
                            <button
                              type="button"
                              onClick={() =>
                                void loadLocalMetricsSnapshot(true)
                              }
                            >
                              RETRY
                            </button>
                          </div>
                        ) : null}
                        <div className="dashboard-metrics-split">
                          <Card className="dashboard-metrics-panel">
                            <div className="dashboard-panel-heading">
                              <div>
                                <span className="dashboard-panel-kicker">
                                  TOKEN MIX
                                </span>
                                <h3>Prompt vs. completion</h3>
                              </div>
                              <span className="dashboard-metrics-live-indicator">
                                {(localInferenceMetrics?.activeRequests ?? 0) >
                                0
                                  ? "INFERENCE ACTIVE"
                                  : "IDLE"}
                              </span>
                            </div>

                            <div className="dashboard-token-breakdown">
                              <div>
                                <span>PROMPT TOKENS</span>
                                <strong>
                                  {formatMetricNumber(
                                    localInferenceMetrics?.promptTokens,
                                  )}
                                </strong>
                                <small>
                                  {formatPercent(localPromptTokenShare)}
                                </small>
                              </div>
                              <div
                                className="dashboard-token-bar"
                                aria-hidden="true"
                              >
                                <span
                                  className="dashboard-token-bar-prompt"
                                  style={{ width: `${localPromptTokenShare}%` }}
                                ></span>
                              </div>
                              <div>
                                <span>COMPLETION TOKENS</span>
                                <strong>
                                  {formatMetricNumber(
                                    localInferenceMetrics?.completionTokens,
                                  )}
                                </strong>
                                <small>
                                  {formatPercent(localCompletionTokenShare)}
                                </small>
                              </div>
                              <div
                                className="dashboard-token-bar"
                                aria-hidden="true"
                              >
                                <span
                                  className="dashboard-token-bar-completion"
                                  style={{
                                    width: `${localCompletionTokenShare}%`,
                                  }}
                                ></span>
                              </div>
                            </div>
                          </Card>

                          <Card className="dashboard-metrics-panel">
                            <div className="dashboard-panel-heading">
                              <div>
                                <span className="dashboard-panel-kicker">
                                  LOCAL RUNTIME
                                </span>
                                <h3>Inference activity</h3>
                              </div>
                            </div>
                            <dl className="dashboard-definition-list dashboard-metrics-definition-list">
                              <div>
                                <dt>ACTIVE REQUESTS</dt>
                                <dd>
                                  {formatMetricNumber(
                                    localInferenceMetrics?.activeRequests,
                                  )}
                                </dd>
                              </div>
                              <div>
                                <dt>SUCCESSFUL</dt>
                                <dd>
                                  {formatMetricNumber(
                                    localInferenceMetrics?.successfulRequests,
                                  )}
                                </dd>
                              </div>
                              <div>
                                <dt>INSTALL JOBS</dt>
                                <dd>
                                  {formatMetricNumber(
                                    localMetrics?.installs.active,
                                  )}{" "}
                                  ACTIVE ·{" "}
                                  {formatMetricNumber(
                                    localMetrics?.installs.completed,
                                  )}{" "}
                                  COMPLETE
                                </dd>
                              </div>
                              <div>
                                <dt>LAST REQUEST</dt>
                                <dd>
                                  {localInferenceMetrics?.lastRequestAt
                                    ? new Date(
                                        localInferenceMetrics.lastRequestAt,
                                      ).toLocaleTimeString()
                                    : "NO REQUESTS YET"}
                                </dd>
                              </div>
                            </dl>
                          </Card>
                        </div>

                        <Card className="dashboard-metrics-table-panel">
                          <div className="dashboard-panel-heading">
                            <div>
                              <span className="dashboard-panel-kicker">
                                INFERENCE LOG
                              </span>
                              <h3>Recent requests</h3>
                            </div>
                            <span className="dashboard-metrics-generated-at">
                              UPDATED{" "}
                              {localMetrics?.generatedAt
                                ? new Date(
                                    localMetrics.generatedAt,
                                  ).toLocaleTimeString()
                                : "--"}
                            </span>
                          </div>
                          <div className="dashboard-metrics-request-header">
                            <span>TIME</span>
                            <span>MODEL</span>
                            <span>RUNTIME</span>
                            <span>TOKENS</span>
                            <span>LATENCY</span>
                            <span>SPEED</span>
                            <span>STATUS</span>
                          </div>
                          {(localMetrics?.recentRequests.length ?? 0) === 0 ? (
                            <div className="dashboard-table-empty">
                              RUN A MODEL REQUEST TO START THE TRACKER
                            </div>
                          ) : (
                            localMetrics?.recentRequests
                              .slice(0, 20)
                              .map((request) => (
                                <div
                                  className="dashboard-metrics-request-row"
                                  key={request.id}
                                >
                                  <span>
                                    {new Date(
                                      request.completedAt,
                                    ).toLocaleTimeString()}
                                  </span>
                                  <code title={request.modelId}>
                                    {request.modelId}
                                  </code>
                                  <span>{request.runtimeId ?? "UNKNOWN"}</span>
                                  <strong>
                                    {formatMetricNumber(request.totalTokens)}
                                  </strong>
                                  <span>
                                    {formatDuration(request.latencyMs)}
                                  </span>
                                  <span>
                                    {formatMetricNumber(
                                      request.tokensPerSecond,
                                    )}{" "}
                                    TOK/S
                                  </span>
                                  <span
                                    className={`dashboard-metrics-status dashboard-metrics-status-${request.status}`}
                                    title={request.error}
                                  >
                                    {request.status.toUpperCase()}
                                  </span>
                                </div>
                              ))
                          )}
                        </Card>

                        <Card className="dashboard-metrics-table-panel">
                          <div className="dashboard-panel-heading">
                            <div>
                              <span className="dashboard-panel-kicker">
                                MODEL BREAKDOWN
                              </span>
                              <h3>Usage by model</h3>
                            </div>
                          </div>
                          <div className="dashboard-metrics-model-header">
                            <span>MODEL</span>
                            <span>RUNTIME</span>
                            <span>REQUESTS</span>
                            <span>TOKENS</span>
                            <span>AVG LATENCY</span>
                            <span>AVG SPEED</span>
                          </div>
                          {(localMetrics?.models.byModel.length ?? 0) === 0 ? (
                            <div className="dashboard-table-empty">
                              NO MODEL USAGE RECORDED IN THIS SERVER SESSION
                            </div>
                          ) : (
                            localMetrics?.models.byModel.map((modelMetric) => (
                              <div
                                className="dashboard-metrics-model-row"
                                key={modelMetric.modelId}
                              >
                                <code title={modelMetric.modelId}>
                                  {modelMetric.modelId}
                                </code>
                                <span>
                                  {modelMetric.runtimeId ?? "UNKNOWN"}
                                </span>
                                <strong>
                                  {formatMetricNumber(modelMetric.requests)}
                                </strong>
                                <span>
                                  {formatMetricNumber(modelMetric.totalTokens)}
                                </span>
                                <span>
                                  {formatDuration(modelMetric.averageLatencyMs)}
                                </span>
                                <span>
                                  {formatMetricNumber(
                                    modelMetric.averageTokensPerSecond,
                                  )}{" "}
                                  TOK/S
                                </span>
                              </div>
                            ))
                          )}
                        </Card>
                      </>
                    )}
                  </div>
                ) : null}

                {activeMetricsTab === "external" ? (
                  <div
                    id="metrics-external-panel"
                    className="dashboard-metrics-tab-panel"
                    role="tabpanel"
                    aria-label="External usage and setup"
                  >
                    <ExternalUsageDashboard
                      connected={localApiConnected}
                      localApiUrl={localApiUrl}
                      localMetrics={localMetrics}
                    />
                  </div>
                ) : null}

                {activeMetricsTab === "pricing" ? (
                  <div
                    id="metrics-pricing-panel"
                    className="dashboard-metrics-tab-panel"
                    role="tabpanel"
                    aria-label="Usage and pricing"
                  >
                    <UsagePricingDashboard
                      authenticated={Boolean(sessionAccessToken)}
                      localMetrics={localMetrics}
                      onSignIn={onSignIn}
                    />
                  </div>
                ) : null}

                {activeMetricsTab === "cloud" ? (
                  <div
                    id="metrics-cloud-panel"
                    className="dashboard-metrics-tab-panel"
                    role="tabpanel"
                    aria-label="Cloud and synchronization health"
                  >
                    <div className="dashboard-metrics-cloud-heading">
                      <div>
                        <span className="dashboard-panel-kicker">
                          CLOUD CONTROL PLANE
                        </span>
                        <h3>Browser session health</h3>
                        <p>
                          These values describe dashboard synchronization only.
                          Local prompts, responses, model files, and local token
                          metrics are not uploaded.
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        disabled={cloudRefreshing}
                        onClick={() => void loadDashboard()}
                      >
                        {cloudRefreshing ? "Syncing cloud" : "Refresh cloud"}
                      </Button>
                    </div>

                    <div className="dashboard-cloud-metrics-grid">
                      <Card className="dashboard-metric-card">
                        <span>CLOUD API</span>
                        <strong>{cloudStatus}</strong>
                        <small>{getApiBaseUrl()}</small>
                      </Card>
                      <Card className="dashboard-metric-card">
                        <span>SYNC ATTEMPTS</span>
                        <strong>
                          {formatMetricNumber(cloudMetrics.syncAttempts)}
                        </strong>
                        <small>
                          {formatMetricNumber(cloudMetrics.failedSyncs)} FAILED
                        </small>
                      </Card>
                      <Card className="dashboard-metric-card">
                        <span>SYNC SUCCESS</span>
                        <strong>{formatPercent(cloudSyncSuccessRate)}</strong>
                        <small>
                          {formatMetricNumber(cloudMetrics.successfulSyncs)}{" "}
                          COMPLETE
                        </small>
                      </Card>
                      <Card className="dashboard-metric-card">
                        <span>CLOUD LATENCY</span>
                        <strong>
                          {formatDuration(cloudMetrics.lastLatencyMs)}
                        </strong>
                        <small>
                          AVG {formatDuration(cloudAverageLatencyMs)}
                        </small>
                      </Card>
                      <Card className="dashboard-metric-card">
                        <span>GATEWAYS</span>
                        <strong>
                          {formatMetricNumber(gatewayRecords.length)}
                        </strong>
                        <small>REGISTRY ENTRIES</small>
                      </Card>
                      <Card className="dashboard-metric-card">
                        <span>SESSION REMAINING</span>
                        <strong>{formatUptime(sessionRemainingSeconds)}</strong>
                        <small>COGNITO ACCESS TOKEN</small>
                      </Card>
                    </div>
                  </div>
                ) : null}
              </section>
            </>
          ) : null}

          {activeRoute === "gateways" ? (
            <section className="dashboard-section dashboard-page-view">
              <div className="dashboard-section-header">
                <div>
                  <span className="dashboard-section-index">05</span>
                  <Badge>LIVE CLOUD REGISTRY</Badge>
                  <h2>Available gateways</h2>
                  <p>
                    Gateways tell the CLI how to resolve and download a model.
                    Choose one, then use its scheme in <code>om pull</code>.
                  </p>
                </div>
                <a
                  className="button button-outline"
                  href="https://github.com/wundercorp/openmodel/blob/main/docs/gateway-authoring.md"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  AUTHOR A GATEWAY
                </a>
              </div>

              {dashboardError ? (
                <div className="authentication-notice authentication-notice-error dashboard-notice">
                  <span>REGISTRY_WARNING</span>
                  <strong>{dashboardError}</strong>
                  <button type="button" onClick={() => void loadDashboard()}>
                    RETRY
                  </button>
                </div>
              ) : null}

              <Card className="dashboard-registry-panel">
                <div className="dashboard-table-header">
                  <span>ID</span>
                  <span>NAME</span>
                  <span>SCHEMES</span>
                  <span>CAPABILITIES</span>
                </div>
                {loadState === "loading" && gatewayRecords.length === 0 ? (
                  <div className="dashboard-table-empty">
                    LOADING REGISTRY...
                  </div>
                ) : gatewayRecords.length === 0 ? (
                  <div className="dashboard-table-empty">
                    NO GATEWAYS RETURNED
                  </div>
                ) : (
                  gatewayRecords.map((gateway) => (
                    <div className="dashboard-table-row" key={gateway.id}>
                      <code>{gateway.id}</code>
                      <strong>{gateway.name}</strong>
                      <span>{gateway.schemes?.join(", ") ?? "package"}</span>
                      <span>
                        {gateway.capabilities?.join(", ") ??
                          gateway.packageName ??
                          "registered"}
                      </span>
                    </div>
                  ))
                )}
              </Card>
            </section>
          ) : null}

          {activeRoute === "account" ? (
            <section className="dashboard-section dashboard-page-view">
              <div className="dashboard-section-header">
                <div>
                  <span className="dashboard-section-index">06</span>
                  <Badge>AUTHENTICATED USER</Badge>
                  <h2>Account and session</h2>
                  <p>
                    Identity details come from the verified Cognito access token
                    and the OpenModel cloud API.
                  </p>
                </div>
              </div>

              <div className="dashboard-grid">
                <Card className="dashboard-panel">
                  <div className="dashboard-panel-heading">
                    <div>
                      <span className="dashboard-panel-kicker">
                        IDENTITY::VERIFIED
                      </span>
                      <h3>Account</h3>
                    </div>
                    <span className="dashboard-online-indicator">ONLINE</span>
                  </div>

                  <dl className="dashboard-definition-list">
                    <div>
                      <dt>NAME</dt>
                      <dd>{displayedName}</dd>
                    </div>
                    <div>
                      <dt>EMAIL</dt>
                      <dd>{displayedEmail ?? "NOT PROVIDED"}</dd>
                    </div>
                    <div>
                      <dt>USER ID</dt>
                      <dd>
                        {dashboardUser?.id ?? localUser?.sub ?? "UNKNOWN"}
                      </dd>
                    </div>
                    <div>
                      <dt>CLIENT ID</dt>
                      <dd>{dashboardUser?.clientId ?? "COGNITO WEB CLIENT"}</dd>
                    </div>
                  </dl>

                  <div className="dashboard-tag-section">
                    <span>GROUPS</span>
                    <div className="dashboard-tags">
                      {displayedGroups.length > 0 ? (
                        displayedGroups.map((group) => (
                          <code key={group}>{group}</code>
                        ))
                      ) : (
                        <code>DEFAULT</code>
                      )}
                    </div>
                  </div>

                  <div className="dashboard-tag-section">
                    <span>PERMISSIONS</span>
                    <div className="dashboard-tags">
                      {displayedPermissions.length > 0 ? (
                        displayedPermissions.map((permission) => (
                          <code key={permission}>{permission}</code>
                        ))
                      ) : (
                        <code>READ ONLY</code>
                      )}
                    </div>
                  </div>
                </Card>

                <Card className="dashboard-panel dashboard-terminal-panel">
                  <div className="terminal-title">
                    <span></span>
                    <span></span>
                    <span></span>
                    <strong>SESSION::INFO</strong>
                  </div>
                  <CodeBlock>{`$ om auth status
authenticated: true
provider: amazon-cognito
cloud-api: ${getApiBaseUrl()}
local-api: ${localApiUrl}
local-api-state: ${localStatusLabel.toLowerCase()}
expires: ${tokenExpiresAt.toISOString()}

$ om gateway list
${
  gatewayRecords
    .map((gateway) => `${gateway.id.padEnd(14)} ${gateway.name}`)
    .join("\n") || "loading..."
}

$ curl ${localApiUrl}/v1/models
${
  localApiConnected
    ? localModels.map((model) => model.id).join("\n") ||
      "no local models returned"
    : "not requested by this browser session"
}`}</CodeBlock>
                </Card>
              </div>
            </section>
          ) : null}
        </div>

        <footer className="dashboard-footer">
          <span>OPENMODEL.SH // AUTHENTICATED BROWSER WORKSPACE</span>
          <div>
            <a
              href="https://github.com/wundercorp"
              target="_blank"
              rel="noopener noreferrer"
            >
              GITHUB
            </a>
            <a
              href="https://discord.gg/w6htGsCkx6"
              target="_blank"
              rel="noopener noreferrer"
            >
              DISCORD
            </a>
            <button type="button" onClick={onSignOut}>
              SIGN OUT
            </button>
          </div>
        </footer>
      </div>
    </main>
  );
}
interface DashboardCommandProps {
  index: string;
  title: string;
  command: string;
  copied: boolean;
  onCopy: () => void;
}

function DashboardCommand({
  index,
  title,
  command,
  copied,
  onCopy,
}: DashboardCommandProps) {
  return (
    <div className="dashboard-command">
      <span className="dashboard-command-index">{index}</span>
      <div>
        <strong>{title}</strong>
        <code>{command}</code>
      </div>
      <button type="button" onClick={onCopy}>
        {copied ? "COPIED" : "COPY"}
      </button>
    </div>
  );
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-status-line">
        <span>OPENMODEL::COMMUNITY</span>
        <span>STATUS: ONLINE</span>
      </div>

      <div className="footer-main">
        <div className="footer-community-copy">
          <Badge>OPEN SOURCE COMMUNITY</Badge>
          <h2>BUILD THE FUTURE</h2>
          <p className="footer-description">
            Join the WunderCorp community, share your gateways, contribute to
            the project, and keep up with new package releases.
          </p>

          <div className="footer-community-actions">
            <a
              className="footer-button footer-button-primary"
              href="https://discord.gg/w6htGsCkx6"
              target="_blank"
              rel="noopener noreferrer"
            >
              <PhosphorIcon icon={DiscordLogoIcon} size={21} weight="fill" />
              <span>JOIN THE DISCORD</span>
              <span aria-hidden="true">↗</span>
            </a>

            <a
              className="footer-button footer-button-secondary"
              href="https://www.npmjs.com/package/@wundercorp/openmodel"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="footer-npm-icon">npm</span>
              <span>VIEW THE NPM PACKAGE</span>
              <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>

        <div className="footer-ascii-shell">
          <div className="footer-ascii-titlebar">
            <span>OPENMODEL.BANNER</span>
            <span>UTF-8</span>
          </div>
          <pre className="footer-ascii" aria-label="OpenModel ASCII wordmark">
            {openModelBanner}
          </pre>
          <div className="footer-ascii-command">
            <span className="footer-ascii-prompt">$</span>
            <span>npm install -g @wundercorp/openmodel</span>
            <span className="footer-ascii-cursor" aria-hidden="true"></span>
          </div>
        </div>
      </div>

      <div className="footer-bottom">
        <a className="footer-brand" href="/">
          <span aria-hidden="true">OM</span>
          <span>OpenModel</span>
        </a>

        <span className="footer-attribution">
          OPENMODEL.SH BY WUNDERCORP, INC.
        </span>

        <div className="footer-social-links">
          <a
            className="footer-social-link"
            href="https://x.com/wundercorp"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Follow WunderCorp on X"
            title="WunderCorp on X"
          >
            <PhosphorIcon icon={XLogoIcon} size={17} weight="bold" />
          </a>

          <a
            className="footer-social-link"
            href="https://github.com/wundercorp"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View WunderCorp on GitHub"
            title="WunderCorp on GitHub"
          >
            <PhosphorIcon icon={GithubLogoIcon} size={19} weight="fill" />
          </a>
        </div>
      </div>
    </footer>
  );
}

