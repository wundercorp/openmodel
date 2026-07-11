import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, CodeBlock } from "./components/ui";
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
  getApiBaseUrl,
  getDashboardUser,
  getGatewayRegistry,
  getLocalModelCatalog,
  getLocalModelInstall,
  getLocalModels,
  startLocalModelInstall,
  type DashboardUser,
  type GatewayRecord,
  type InstallableLocalModel,
  type LocalModelRecord,
  type ModelInstallJob,
} from "./lib/api";

type Theme = "dark" | "light";
type Accent = "orange" | "green" | "blue" | "fuchsia";
type DashboardLoadState = "idle" | "loading" | "ready" | "error";
type LocalApiState = "idle" | "loading" | "connected" | "offline";
type DashboardRoute =
  | "overview"
  | "models"
  | "builderstudio"
  | "doku"
  | "gateways"
  | "account";

interface DashboardCache {
  user?: DashboardUser;
  gateways: GatewayRecord[];
  updatedAt: number;
}

const dashboardCacheKey = "openmodel:dashboard-cache";
const modelInstallJobStorageKey = "openmodel:model-install-job";

const dashboardRouteItems: Array<{
  route: DashboardRoute;
  index: string;
  label: string;
}> = [
  { route: "overview", index: "01", label: "OVERVIEW" },
  { route: "models", index: "02", label: "MODELS" },
  { route: "builderstudio", index: "03", label: "USE MODELS" },
  { route: "doku", index: "04", label: "DOKU.SH" },
  { route: "gateways", index: "05", label: "GATEWAYS" },
  { route: "account", index: "06", label: "ACCOUNT" },
];

function readDashboardRoute(): DashboardRoute {
  const route = new URLSearchParams(window.location.search).get("view");
  return dashboardRouteItems.some((item) => item.route === route)
    ? (route as DashboardRoute)
    : "overview";
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

const gateways = [
  ["Hugging Face", "hf://", "GGUF and registry artifacts"],
  ["Direct HTTPS", "https://", "Portable model artifacts"],
  ["Ollama", "ollama://", "Native Ollama registry models"],
  ["Your gateway", "npm package", "Versioned SDK and explicit registration"],
];

const starterModelFallback: InstallableLocalModel = {
  id: "qwen2.5-0.5b-instruct-q4",
  name: "Qwen2.5 0.5B Instruct",
  description: "A compact instruction model intended as a quick first local download.",
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
    () => (localStorage.getItem("openmodel:accent") as Accent) || "orange",
  );
  const [session, setSession] = useState<AuthSession | undefined>(() =>
    getSession(),
  );
  const [authenticationBusy, setAuthenticationBusy] = useState(
    () => window.location.pathname === "/auth/callback",
  );
  const [authenticationError, setAuthenticationError] = useState<string | undefined>(() =>
    consumeSessionValidationNotice(),
  );

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
  const isAuthCallback =
    currentPath === "/auth/callback" ||
    currentPath.startsWith("/auth/callback/");
  const sessionUser = useMemo(() => getSessionUser(session), [session]);

  return (
    <div className="page-shell">
      {!isDashboard ? (
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

      {authenticationError && !isDashboard && !isAuthCallback ? (
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

      {isAuthCallback ? (
        <AuthCallbackPage
          busy={authenticationBusy}
          error={authenticationError}
          onRetry={() => void startSignIn("/dashboard")}
        />
      ) : isDashboard ? (
        <DashboardPage
          theme={theme}
          accent={accent}
          session={session}
          authenticationError={authenticationError}
          onThemeChange={() =>
            setTheme((currentTheme) =>
              currentTheme === "dark" ? "light" : "dark",
            )
          }
          onAccentChange={setAccent}
          onSignIn={() => void startSignIn("/dashboard")}
          onSignOut={() => void signOut()}
          onSessionChange={synchronizeSession}
        />
      ) : (
        <LandingPage />
      )}

      {!isDashboard && !isAuthCallback ? <SiteFooter /> : null}
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
        {sessionLabel ? (
          <span className="header-session-label" title={sessionLabel}>
            {sessionLabel}
          </span>
        ) : null}

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
          <>
            <a
              className="button button-outline header-dashboard-button"
              href="/dashboard"
            >
              DASHBOARD
            </a>
            <Button
              variant="ghost"
              disabled={authenticationBusy}
              onClick={onSignOut}
            >
              {authenticationBusy ? "WAIT" : "SIGN OUT"}
            </Button>
          </>
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
            Download portable artifacts, use native registries, run models
            through llama.cpp or Ollama, with one interoperable local API.
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
              onClick={() =>
                document
                  .getElementById("gateways")
                  ?.scrollIntoView({ behavior: "smooth" })
              }
            >
              EXPLORE GATEWAYS
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
  busy: boolean;
  error?: string;
  onRetry: () => void;
}

function AuthCallbackPage({ busy, error, onRetry }: AuthCallbackPageProps) {
  return (
    <main className="auth-callback-page">
      <Card className="auth-callback-panel">
        <div className="terminal-title">
          <span></span>
          <span></span>
          <span></span>
          <strong>AUTH::CALLBACK</strong>
        </div>
        <div className="auth-callback-content">
          <Badge>{error ? "AUTHENTICATION ERROR" : "COGNITO CALLBACK"}</Badge>
          <h1>{error ? "SIGN IN FAILED" : "ESTABLISHING SESSION"}</h1>
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
              <Button onClick={onRetry}>TRY SIGN IN AGAIN</Button>
              <a className="button button-outline" href="/">
                RETURN HOME
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
  accent: Accent;
  session?: AuthSession;
  authenticationError?: string;
  onThemeChange: () => void;
  onAccentChange: (accent: Accent) => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onSessionChange: () => void;
}

function DashboardPage({
  theme,
  accent,
  session,
  authenticationError,
  onThemeChange,
  onAccentChange,
  onSignIn,
  onSignOut,
  onSessionChange,
}: DashboardPageProps) {
  const [initialDashboardCache] = useState(() => readDashboardCache());
  const [activeRoute, setActiveRoute] = useState<DashboardRoute>(() =>
    readDashboardRoute(),
  );
  const [loadState, setLoadState] = useState<DashboardLoadState>(() =>
    initialDashboardCache ? "ready" : "idle",
  );
  const [cloudRefreshing, setCloudRefreshing] = useState(false);
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
  const [localModelCatalog, setLocalModelCatalog] = useState<InstallableLocalModel[]>([]);
  const [modelInstallJob, setModelInstallJob] = useState<ModelInstallJob>();
  const [modelInstallError, setModelInstallError] = useState<string>();
  const [selectedModelId, setSelectedModelId] = useState<string>();
  const [copiedCommand, setCopiedCommand] = useState<string>();
  const dashboardRequestId = useRef(0);
  const localApiRequestId = useRef(0);
  const dashboardAbortController = useRef<AbortController | undefined>(undefined);
  const localApiAbortController = useRef<AbortController | undefined>(undefined);
  const modelInstallAbortController = useRef<AbortController | undefined>(undefined);
  const initialCloudLoadStarted = useRef(false);
  const dashboardData = useRef({
    user: initialDashboardCache?.user,
    gateways: initialDashboardCache?.gateways ?? [],
  });
  const localUser = useMemo(() => getSessionUser(session), [session]);
  const sessionAccessToken = session?.access_token;

  const navigateDashboard = useCallback((route: DashboardRoute) => {
    const nextUrl =
      route === "overview" ? "/dashboard" : `/dashboard?view=${route}`;
    window.history.pushState({ dashboardRoute: route }, "", nextUrl);
    setActiveRoute(route);
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const navigateHome = useCallback(() => {
    window.location.assign("/");
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setActiveRoute(readDashboardRoute());
      window.scrollTo({ top: 0, behavior: "auto" });
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

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

    if (
      userResult.status === "fulfilled" ||
      gatewayResult.status === "fulfilled"
    ) {
      const updatedAt = Date.now();
      setLastCloudSyncAt(updatedAt);
      writeDashboardCache({
        user: nextUser,
        gateways: nextGateways,
        updatedAt,
      });
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
      const [modelsResult, catalogResult] = await Promise.allSettled([
        getLocalModels(normalizedUrl, abortController.signal),
        getLocalModelCatalog(normalizedUrl, abortController.signal),
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

      const storedInstallJobId = localStorage.getItem(modelInstallJobStorageKey);
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

  const refreshLocalModelsSilently = useCallback(async (requestedUrl: string) => {
    try {
      const [models, catalog] = await Promise.all([
        getLocalModels(requestedUrl),
        getLocalModelCatalog(requestedUrl),
      ]);
      setLocalModels(models);
      setLocalModelCatalog(catalog);
      setLocalApiState("connected");
      setLocalApiError(undefined);
      return true;
    } catch {
      return false;
    }
  }, []);

  const disconnectLocalApi = useCallback(() => {
    localApiAbortController.current?.abort();
    modelInstallAbortController.current?.abort();
    localApiRequestId.current += 1;
    setLocalApiState("idle");
    setLocalApiError(undefined);
    setLocalModels([]);
    setLocalModelCatalog([]);
    setModelInstallJob(undefined);
    setModelInstallError(undefined);
    setSelectedModelId(undefined);
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
    modelInstallJob &&
    !["completed", "error"].includes(modelInstallJob.status)
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
    return () => {
      dashboardRequestId.current += 1;
      localApiRequestId.current += 1;
      dashboardAbortController.current?.abort();
      localApiAbortController.current?.abort();
      modelInstallAbortController.current?.abort();
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

  const copyCommand = useCallback(async (commandId: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedCommand(commandId);
    window.setTimeout(() => {
      setCopiedCommand((currentCommandId) =>
        currentCommandId === commandId ? undefined : currentCommandId,
      );
    }, 1600);
  }, []);

  if (!session) {
    const configurationError = getAuthConfigurationError();
    return (
      <main className="dashboard-page dashboard-auth-gate">
        <button
          className="dashboard-auth-brand"
          type="button"
          onClick={navigateHome}
        >
          <span aria-hidden="true">&gt;_</span>
          <span>OPENMODEL.SH</span>
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
            <h1>LOGIN</h1>
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
              <Button onClick={onSignIn}>SIGN IN WITH COGNITO</Button>
              <Button variant="outline" onClick={navigateHome}>
                RETURN HOME
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
  const starterModel = localModelCatalog[0];
  const displayedStarterModel = starterModel ?? starterModelFallback;
  const starterInstalledModelId =
    starterModel?.installedModelId ??
    (modelInstallJob?.status === "completed" ? modelInstallJob.modelId : undefined);
  const starterModelInstalled = Boolean(
    starterModel?.installed ||
      (starterInstalledModelId &&
        localModels.some((model) => model.id === starterInstalledModelId)),
  );
  const modelInstallInProgress = Boolean(
    modelInstallJob &&
      !["completed", "error"].includes(modelInstallJob.status),
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
  const serveCommand = `om serve ${selectedModel?.id ?? "local"} --port 11435`;
  const requestCommand = `curl ${localApiUrl}/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{"model":"${selectedModel?.id ?? "local"}","messages":[{"role":"user","content":"Hello"}]}'`;
  const activeLocalModelId =
    selectedModel?.id ?? localModels[0]?.id ?? modelInstallJob?.modelId;
  const builderStudioProfileId = "openmodel-local";
  const builderStudioModelId = activeLocalModelId ?? "YOUR_MODEL_ID";
  const builderStudioBaseUrl = `${localApiUrl}/v1`;
  const builderStudioInstallCommand =
    "npm install -g @wundercorp/bs@latest";
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
  const dokuOpenCommand =
    "doku open ./doku.docs.json --site https://doku.sh";
  const dokuRefreshCommand =
    "doku gen && doku pack . --output doku.docs.json";
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
  const localStatusLabel =
    localApiState === "loading"
      ? "CONNECTING"
      : localApiConnected
        ? "CONNECTED"
        : localApiState === "offline"
          ? "OFFLINE"
          : "NOT CONNECTED";
  const activeRouteLabel = activeRoute.toUpperCase();

  return (
    <main className="dashboard-app-shell">
      <aside className="dashboard-sidebar">
        <button
          className="dashboard-sidebar-brand"
          type="button"
          onClick={navigateHome}
        >
          <span className="dashboard-sidebar-brand-mark" aria-hidden="true">
            &gt;_
          </span>
          <span>
            <strong>OPENMODEL</strong>
            <small>CONTROL PLANE</small>
          </span>
        </button>

        <div className="dashboard-sidebar-user">
          <span className="dashboard-user-avatar">{userInitials}</span>
          <span className="dashboard-sidebar-user-copy">
            <strong>{displayedName}</strong>
            <small>{displayedEmail ?? "COGNITO USER"}</small>
          </span>
          <span className="dashboard-user-presence" title="Authenticated"></span>
        </div>

        <nav className="dashboard-sidebar-nav" aria-label="Dashboard pages">
          {dashboardRouteItems.map((item) => (
            <button
              key={item.route}
              className={activeRoute === item.route ? "is-active" : undefined}
              type="button"
              aria-current={activeRoute === item.route ? "page" : undefined}
              onClick={() => navigateDashboard(item.route)}
            >
              <span>{item.index}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="dashboard-sidebar-spacer"></div>

        <div className="dashboard-sidebar-status">
          <span>LOCAL API</span>
          <strong className={localApiConnected ? "is-online" : "is-offline"}>
            {localStatusLabel}
          </strong>
          <small>{localApiUrl}</small>
        </div>

        <div className="dashboard-sidebar-controls">
          <select
            aria-label="Dashboard accent color"
            value={accent}
            onChange={(event) => onAccentChange(event.target.value as Accent)}
          >
            <option value="orange">ORANGE</option>
            <option value="green">GREEN</option>
            <option value="blue">BLUE</option>
            <option value="fuchsia">FUCHSIA</option>
          </select>
          <Button variant="outline" onClick={onThemeChange}>
            {theme === "dark" ? "LIGHT MODE" : "OLED MODE"}
          </Button>
          <Button variant="ghost" onClick={onSignOut}>
            SIGN OUT
          </Button>
        </div>
      </aside>

      <div className="dashboard-workspace">
        <header className="dashboard-topbar">
          <div className="dashboard-breadcrumb">
            <span>OPENMODEL</span>
            <span>/</span>
            <strong>{activeRouteLabel}</strong>
          </div>

          <div className="dashboard-browser-session">
            <span className="dashboard-browser-session-status"></span>
            <span>
              <strong>{displayedName}</strong>
              <small>BROWSER SESSION · COGNITO</small>
            </span>
            <span className="dashboard-user-avatar dashboard-user-avatar-small">
              {userInitials}
            </span>
          </div>
        </header>

        <div className="dashboard-content">
          {activeRoute === "overview" ? (
            <section className="dashboard-section dashboard-overview dashboard-page-view">
              <div className="dashboard-page-heading">
                <div>
                  <Badge>AUTHENTICATED CONTROL PLANE</Badge>
                  <h1>LOCAL INFERENCE WORKSPACE</h1>
                  <p>
                    Connect the browser to the OpenModel runtime on this computer,
                    select an installed model, and copy the API request you need.
                  </p>
                </div>
                <div className="dashboard-page-actions">
                  <Button
                    variant="outline"
                    disabled={cloudRefreshing}
                    onClick={() => void loadDashboard()}
                  >
                    {cloudRefreshing ? "SYNCING CLOUD" : "REFRESH CLOUD"}
                  </Button>
                  <Button variant="ghost" onClick={navigateHome}>
                    VIEW SITE
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
                  <span className="dashboard-status-label">BROWSER SESSION</span>
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
                  <strong>{String(gatewayRecords.length).padStart(2, "0")}</strong>
                  <span className="dashboard-status-detail">AVAILABLE SOURCES</span>
                </Card>
                <Card className="dashboard-status-card">
                  <span className="dashboard-status-label">LOCAL MODELS</span>
                  <strong>{String(localModels.length).padStart(2, "0")}</strong>
                  <span className="dashboard-status-detail">{localStatusLabel}</span>
                </Card>
              </div>

              <div className="dashboard-overview-actions">
                <Card className="dashboard-overview-action-card">
                  <span className="dashboard-panel-kicker">NEXT ACTION</span>
                  <h3>
                    {localApiConnected
                      ? localModels.length > 0
                        ? "SELECT A MODEL AND SEND A REQUEST"
                        : "INSTALL YOUR FIRST LOCAL MODEL"
                      : "CONNECT YOUR LOCAL OPENMODEL RUNTIME"}
                  </h3>
                  <p>
                    {localApiConnected
                      ? localModels.length > 0
                        ? "Your runtime is online. Open Models to select an installed model and copy a ready-to-run request."
                        : "The runtime is online and ready. Open Models, then install the recommended starter model with one click."
                      : "Start om serve once, then Open Models and install the recommended starter model directly from the dashboard."}
                  </p>
                  <Button onClick={() => navigateDashboard("models")}>
                    OPEN MODELS
                  </Button>
                </Card>

                <Card className="dashboard-overview-action-card">
                  <span className="dashboard-panel-kicker">LOCAL AI WORKFLOW</span>
                  <h3>USE YOUR MODEL IN BUILDERSTUDIO</h3>
                  <p>
                    Generate the exact local provider configuration for the model
                    selected on this computer, then start asking questions or
                    making code changes from your project directory.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => navigateDashboard("builderstudio")}
                  >
                    OPEN MODEL WORKFLOW
                  </Button>
                </Card>

                <Card className="dashboard-overview-action-card">
                  <span className="dashboard-panel-kicker">DOCUMENTATION</span>
                  <h3>GENERATE PROJECT DOCS WITH DOKU.SH</h3>
                  <p>
                    Create docs.json, llms-full.txt, and a packed documentation
                    portal while your project evolves.
                  </p>
                  <Button variant="outline" onClick={() => navigateDashboard("doku")}>
                    OPEN DOKU WORKFLOW
                  </Button>
                </Card>

                <Card className="dashboard-overview-action-card">
                  <span className="dashboard-panel-kicker">CLOUD REGISTRY</span>
                  <h3>{gatewayRecords.length} GATEWAYS AVAILABLE</h3>
                  <p>
                    Review supported URI schemes and capabilities before choosing
                    the source for your next model pull.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => navigateDashboard("gateways")}
                  >
                    VIEW GATEWAYS
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
                  <h2>INSTALL AND RUN A MODEL</h2>
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

              <Card className={`dashboard-model-installer ${starterModelInstalled ? "is-installed" : ""}`}>
                <div className="dashboard-model-installer-main">
                  <div className="dashboard-model-installer-status" aria-hidden="true">
                    {starterModelInstalled ? "✓" : modelInstallInProgress ? ">_" : "↓"}
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
                      <span>{formatBytes(displayedStarterModel.sizeBytes)}</span>
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
                      <span style={{ width: `${modelInstallProgress}%` }}></span>
                    </div>
                    <div className="dashboard-model-progress-meta">
                      <span>{modelInstallJob.stage.toUpperCase()}</span>
                      <span>
                        {formatBytes(modelInstallJob.downloadedBytes)} / {formatBytes(
                          modelInstallJob.totalBytes ?? displayedStarterModel.sizeBytes,
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
                        void copyCommand("serve-service", "om serve --port 11435")
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
                  <h3>INSTALLED MODELS</h3>
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
                      <strong>✓ INSTALLED</strong>
                      <button
                        type="button"
                        onClick={() => setSelectedModelId(model.id)}
                      >
                        {model.id === selectedModelId ? "SELECTED" : "USE MODEL"}
                      </button>
                    </div>
                  ))}
                </Card>
              ) : (
                <Card className="dashboard-empty-models dashboard-empty-models-compact">
                  <div className="dashboard-empty-models-symbol" aria-hidden="true">
                    [ ]
                  </div>
                  <div>
                    <span className="dashboard-panel-kicker">REGISTRY::EMPTY</span>
                    <h3>NO LOCAL MODELS YET</h3>
                    <p>
                      Use the Install button above. The model will appear here
                      automatically when the download completes.
                    </p>
                  </div>
                </Card>
              )}

              {selectedModel ? (
                <div className="dashboard-next-step-layout">
                  <Card className="dashboard-next-step-panel">
                    <div className="dashboard-panel-heading">
                      <div>
                        <span className="dashboard-panel-kicker">NEXT: START INFERENCE</span>
                        <h3>{selectedModel.id}</h3>
                      </div>
                      <span className="dashboard-online-indicator">SELECTED</span>
                    </div>
                    <div className="dashboard-command-list">
                      <DashboardCommand
                        index="01"
                        title="SERVE THIS MODEL"
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
                        onCopy={() => void copyCommand("request", requestCommand)}
                      />
                    </div>
                  </Card>

                  <Card className="dashboard-context-panel">
                    <span className="dashboard-panel-kicker">CONNECTION DETAILS</span>
                    <h3>USE IT FROM EXISTING TOOLS</h3>
                    <p>
                      Point an OpenAI-compatible client at the local API and use
                      the selected model ID.
                    </p>
                    <dl>
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
                      onClick={() => navigateDashboard("builderstudio")}
                    >
                      USE WITH BUILDERSTUDIO
                    </Button>
                  </Card>
                </div>
              ) : null}
            </section>
          ) : null}

          {activeRoute === "builderstudio" ? (
            <section className="dashboard-section dashboard-page-view">
              <div className="dashboard-section-header">
                <div>
                  <span className="dashboard-section-index">03</span>
                  <Badge>LOCAL AI TOOLING</Badge>
                  <h2>USE YOUR MODEL WITH BUILDERSTUDIO</h2>
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
                  <Button variant="ghost" onClick={() => navigateDashboard("models")}>
                    MANAGE MODELS
                  </Button>
                </div>
              </div>

              <Card className="dashboard-tool-readiness">
                <div className="dashboard-tool-readiness-status">
                  <span
                    className={`dashboard-tool-status-dot ${
                      localApiConnected && activeLocalModelId ? "is-ready" : ""
                    }`}
                  ></span>
                  <div>
                    <span className="dashboard-panel-kicker">LOCAL MODEL STATUS</span>
                    <strong>
                      {!localApiConnected
                        ? "CONNECT THE LOCAL SERVICE"
                        : activeLocalModelId
                          ? "READY FOR BUILDERSTUDIO"
                          : "INSTALL OR SELECT A MODEL"}
                    </strong>
                  </div>
                </div>

                <div className="dashboard-tool-readiness-actions">
                  {!localApiConnected ? (
                    <Button
                      disabled={localApiState === "loading"}
                      onClick={() => void loadLocalModelRegistry(localApiInput)}
                    >
                      {localApiState === "loading" ? "CONNECTING" : "CONNECT LOCAL API"}
                    </Button>
                  ) : localModels.length === 0 ? (
                    <Button onClick={() => navigateDashboard("models")}>
                      INSTALL A MODEL
                    </Button>
                  ) : (
                    <label className="dashboard-tool-model-select">
                      <span>MODEL</span>
                      <select
                        value={activeLocalModelId}
                        onChange={(event) => setSelectedModelId(event.target.value)}
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
                      <span className="dashboard-panel-kicker">QUICK SETUP</span>
                      <h3>CONNECT THE CURRENT PROJECT</h3>
                    </div>
                    <button
                      className="dashboard-copy-all-button"
                      type="button"
                      disabled={!activeLocalModelId}
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

                  {!activeLocalModelId ? (
                    <div className="dashboard-tool-inline-notice">
                      Connect the local service and select an installed model to
                      generate the final commands.
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
                    <span className="dashboard-panel-kicker">ACTIVE CONFIGURATION</span>
                    <h3>OPENMODEL LOCAL</h3>
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
                        <h3>ASK ABOUT YOUR PROJECT</h3>
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

          {activeRoute === "doku" ? (
            <section className="dashboard-section dashboard-page-view">
              <div className="dashboard-section-header">
                <div>
                  <span className="dashboard-section-index">04</span>
                  <Badge>DOCUMENTATION WORKFLOW</Badge>
                  <h2>GENERATE DOCS AS YOU BUILD</h2>
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
                      <h3>CREATE AND OPEN YOUR DOCS</h3>
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
                      onCopy={() => void copyCommand("doku-pack", dokuPackCommand)}
                    />
                    <DashboardCommand
                      index="04"
                      title="OPEN IT ON DOKU.SH"
                      command={dokuOpenCommand}
                      copied={copiedCommand === "doku-open"}
                      onCopy={() => void copyCommand("doku-open", dokuOpenCommand)}
                    />
                  </div>
                </Card>

                <div className="dashboard-tool-side-column">
                  <Card className="dashboard-context-panel dashboard-tool-summary">
                    <span className="dashboard-panel-kicker">GENERATED OUTPUT</span>
                    <h3>FILES DOKU CREATES</h3>
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
                        <span>Packed navigation and page content for the portal.</span>
                      </div>
                    </div>
                  </Card>

                  <Card className="dashboard-next-step-panel dashboard-tool-try-panel">
                    <div className="dashboard-panel-heading">
                      <div>
                        <span className="dashboard-panel-kicker">ONGOING WORKFLOW</span>
                        <h3>REFRESH DOCS AFTER CHANGES</h3>
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
                    <span className="dashboard-panel-kicker">OPTIONAL AUTOMATION</span>
                    <h3>ADD DOKU TO PACKAGE.JSON</h3>
                  </div>
                  <button
                    className="dashboard-copy-all-button"
                    type="button"
                    onClick={() =>
                      void copyCommand("doku-package-scripts", dokuPackageScripts)
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

          {activeRoute === "gateways" ? (
            <section className="dashboard-section dashboard-page-view">
              <div className="dashboard-section-header">
                <div>
                  <span className="dashboard-section-index">05</span>
                  <Badge>LIVE CLOUD REGISTRY</Badge>
                  <h2>AVAILABLE GATEWAYS</h2>
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
                  <div className="dashboard-table-empty">LOADING REGISTRY...</div>
                ) : gatewayRecords.length === 0 ? (
                  <div className="dashboard-table-empty">NO GATEWAYS RETURNED</div>
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
                  <h2>ACCOUNT AND SESSION</h2>
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
                      <span className="dashboard-panel-kicker">IDENTITY::VERIFIED</span>
                      <h3>ACCOUNT</h3>
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
                      <dd>{dashboardUser?.id ?? localUser?.sub ?? "UNKNOWN"}</dd>
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
                        displayedGroups.map((group) => <code key={group}>{group}</code>)
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
    ? localModels.map((model) => model.id).join("\n") || "no local models returned"
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
          <h2>BUILD THE FUTURE OF LOCAL INFERENCE WITH US.</h2>
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
              <DiscordIcon />
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
          <span aria-hidden="true">&gt;_</span>
          <span>OPENMODEL.SH</span>
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
            <XIcon />
          </a>

          <a
            className="footer-social-link"
            href="https://github.com/wundercorp"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View WunderCorp on GitHub"
            title="WunderCorp on GitHub"
          >
            <GithubIcon />
          </a>
        </div>
      </div>
    </footer>
  );
}

function DiscordIcon() {
  return (
    <svg
      width="21"
      height="21"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M20.317 4.369a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.211.375-.444.864-.608 1.249a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.249.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.579.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.095.252-.194.371-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03ZM8.02 15.332c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.334-.956 2.419-2.157 2.419Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.334-.947 2.419-2.157 2.419Z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.657l-5.214-6.817-5.967 6.817H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
    </svg>
  );
}

function GithubIcon() {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.04 1.77 2.72 1.26 3.38.96.1-.75.4-1.26.74-1.55-2.57-.3-5.28-1.29-5.28-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18A10.9 10.9 0 0 1 12 6.12c.98 0 1.95.13 2.87.39 2.19-1.49 3.15-1.18 3.15-1.18.64 1.58.24 2.76.12 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.07.79 2.16v3.24c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}
