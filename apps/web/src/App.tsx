import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, CodeBlock } from "./components/ui";
import {
  beginLogin,
  completeLogin,
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
  type DashboardUser,
  type GatewayRecord,
} from "./lib/api";

type Theme = "dark" | "light";
type Accent = "orange" | "green" | "blue" | "fuchsia";
type DashboardLoadState = "idle" | "loading" | "ready" | "error";

const gateways = [
  ["Hugging Face", "hf://", "GGUF and registry artifacts"],
  ["Direct HTTPS", "https://", "Portable model artifacts"],
  ["Ollama", "ollama://", "Native Ollama registry models"],
  ["Your gateway", "npm package", "Versioned SDK and explicit registration"],
];

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
  const [authenticationError, setAuthenticationError] = useState<string>();

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

      {authenticationError && !isDashboard && !isAuthCallback ? (
        <div className="authentication-notice authentication-notice-error">
          <span>AUTH_ERROR</span>
          <strong>{authenticationError}</strong>
          <button type="button" onClick={() => setAuthenticationError(undefined)}>
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
          session={session}
          authenticationError={authenticationError}
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
            <a className="button button-outline header-dashboard-button" href="/dashboard">
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
            Contributors add providers through a small public SDK. Core
            commands remain provider-neutral and runtime-neutral.
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
            Serve installed models through OpenAI-compatible chat completions
            or Ollama-compatible generation endpoints.
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
  session?: AuthSession;
  authenticationError?: string;
  onSignIn: () => void;
  onSignOut: () => void;
  onSessionChange: () => void;
}

function DashboardPage({
  session,
  authenticationError,
  onSignIn,
  onSignOut,
  onSessionChange,
}: DashboardPageProps) {
  const [loadState, setLoadState] = useState<DashboardLoadState>("idle");
  const [dashboardUser, setDashboardUser] = useState<DashboardUser>();
  const [gatewayRecords, setGatewayRecords] = useState<GatewayRecord[]>([]);
  const [dashboardError, setDashboardError] = useState<string>();
  const dashboardRequestId = useRef(0);
  const localUser = useMemo(() => getSessionUser(session), [session]);
  const sessionAccessToken = session?.access_token;

  const loadDashboard = useCallback(async () => {
    if (!sessionAccessToken) {
      return;
    }

    const requestId = dashboardRequestId.current + 1;
    dashboardRequestId.current = requestId;
    setLoadState("loading");
    setDashboardError(undefined);

    const [userResult, gatewayResult] = await Promise.allSettled([
      getDashboardUser(),
      getGatewayRegistry(),
    ]);

    if (requestId !== dashboardRequestId.current) {
      return;
    }

    if (userResult.status === "fulfilled") {
      setDashboardUser(userResult.value);
    }
    if (gatewayResult.status === "fulfilled") {
      setGatewayRecords(gatewayResult.value);
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

    if (errors.length > 0) {
      setDashboardError(errors.join(" "));
      setLoadState("error");
      return;
    }

    setLoadState("ready");
  }, [onSessionChange, sessionAccessToken]);

  useEffect(() => {
    void loadDashboard();

    return () => {
      dashboardRequestId.current += 1;
    };
  }, [loadDashboard]);

  if (!session) {
    const configurationError = getAuthConfigurationError();
    return (
      <main className="dashboard-page dashboard-auth-gate">
        <Card className="dashboard-auth-panel">
          <div className="terminal-title">
            <span></span>
            <span></span>
            <span></span>
            <strong>DASHBOARD::ACCESS</strong>
          </div>
          <div className="dashboard-auth-content">
            <Badge>AUTHENTICATION REQUIRED</Badge>
            <h1>CONNECT YOUR OPENMODEL ACCOUNT</h1>
            <p>
              Sign in through Amazon Cognito to load your account, token status,
              API identity, and gateway registry.
            </p>
            {authenticationError || configurationError ? (
              <div className="dashboard-inline-error">
                {authenticationError ?? configurationError}
              </div>
            ) : null}
            <div className="hero-actions">
              <Button onClick={onSignIn}>SIGN IN WITH COGNITO</Button>
              <a className="button button-outline" href="/">
                RETURN HOME
              </a>
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

  return (
    <main className="dashboard-page">
      <section className="dashboard-hero">
        <div>
          <Badge>AUTHENTICATED CONTROL PLANE</Badge>
          <h1>DASHBOARD</h1>
          <p>
            Signed in as <strong>{displayedName}</strong>. This page reads your
            verified identity from the OpenModel API and loads the live gateway
            registry.
          </p>
        </div>
        <div className="dashboard-hero-actions">
          <Button
            variant="outline"
            disabled={loadState === "loading"}
            onClick={() => void loadDashboard()}
          >
            {loadState === "loading" ? "REFRESHING" : "REFRESH DATA"}
          </Button>
          <Button variant="ghost" onClick={onSignOut}>
            SIGN OUT
          </Button>
        </div>
      </section>

      {dashboardError ? (
        <div className="authentication-notice authentication-notice-error dashboard-notice">
          <span>API_ERROR</span>
          <strong>{dashboardError}</strong>
          <button type="button" onClick={() => void loadDashboard()}>
            RETRY
          </button>
        </div>
      ) : null}

      <section className="dashboard-status-grid">
        <Card className="dashboard-status-card">
          <span className="dashboard-status-label">SESSION</span>
          <strong>ACTIVE</strong>
          <span className="dashboard-status-detail">
            EXPIRES {tokenExpiresAt.toLocaleString()}
          </span>
        </Card>
        <Card className="dashboard-status-card">
          <span className="dashboard-status-label">CLOUD API</span>
          <strong>{apiConnected ? "CONNECTED" : loadState.toUpperCase()}</strong>
          <span className="dashboard-status-detail">{getApiBaseUrl()}</span>
        </Card>
        <Card className="dashboard-status-card">
          <span className="dashboard-status-label">GATEWAYS</span>
          <strong>{String(gatewayRecords.length).padStart(2, "0")}</strong>
          <span className="dashboard-status-detail">REGISTRY RECORDS</span>
        </Card>
      </section>

      <section className="dashboard-grid">
        <Card className="dashboard-panel">
          <div className="dashboard-panel-heading">
            <div>
              <span className="dashboard-panel-kicker">IDENTITY::VERIFIED</span>
              <h2>ACCOUNT</h2>
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
api: ${getApiBaseUrl()}
expires: ${tokenExpiresAt.toISOString()}

$ om gateway list
${gatewayRecords
  .map((gateway) => `${gateway.id.padEnd(14)} ${gateway.name}`)
  .join("\n") || "loading..."}`}</CodeBlock>
        </Card>
      </section>

      <section className="dashboard-registry-section">
        <div className="section-heading dashboard-section-heading">
          <Badge>LIVE REGISTRY</Badge>
          <h2>AVAILABLE GATEWAYS</h2>
          <p>
            Public gateway metadata loaded from the deployed OpenModel cloud
            API.
          </p>
        </div>

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
    </main>
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
