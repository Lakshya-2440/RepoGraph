import { FormEvent, startTransition, useDeferredValue, useEffect, useRef, useState } from "react";

import type { AnalysisResult, AuthUser, NodeDetailResponse, RepoAiInsightsResponse, SearchResult } from "@shared/index";

import { CommandPalette } from "./components/CommandPalette";
import { ContributorView } from "./components/ContributorView";
import { ControlBar } from "./components/ControlBar";
import { DependencyTree } from "./components/DependencyTree";
import { FileExplorer } from "./components/FileExplorer";
import { GraphCanvas } from "./components/GraphCanvas";
import { InsightsExplorer } from "./components/InsightsExplorer";
import { NodePanel } from "./components/NodePanel";
import { RepoChatbot } from "./components/RepoChatbot";
import { StatsView } from "./components/StatsView";
import { SummarySidebar } from "./components/SummarySidebar";
import {
  analyzeSource,
  clearAuthToken,
  fetchAiInsights,
  fetchCurrentAnalysis,
  fetchHealth,
  fetchMe,
  fetchNodeDetails,
  getAuthToken,
  login,
  loginWithGoogle,
  requestEmailVerification,
  register,
  verifyEmail,
  searchNodes
} from "./lib/api";
import { formatDate } from "./lib/format";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (options: {
            client_id: string;
            callback: (response: { credential?: string }) => void;
          }) => void;
          renderButton: (
            parent: HTMLElement,
            options: { theme?: string; size?: string; width?: number; shape?: "rectangular" | "pill" | "circle" | "square" }
          ) => void;
        };
      };
    };
  }
}

type AppView = "graph" | "explorer" | "stats" | "insights" | "dependencies" | "contributors";

const VIEW_LABELS: Record<AppView, string> = {
  graph: "Graph",
  explorer: "Explorer",
  stats: "Analytics",
  insights: "Insights",
  dependencies: "Deps",
  contributors: "Team"
};

const DEFAULT_SOURCE = "";
const GOOGLE_GSI_SCRIPT_SRC = "https://accounts.google.com/gsi/client";

export function App() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authInfo, setAuthInfo] = useState<string | null>(null);
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(null);
  const [googleAuthError, setGoogleAuthError] = useState<string | null>(null);
  const [googleButtonVisible, setGoogleButtonVisible] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [source, setSource] = useState(DEFAULT_SOURCE);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeDetails, setNodeDetails] = useState<NodeDetailResponse | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [loadingNode, setLoadingNode] = useState(false);
  const [booting, setBooting] = useState(true);
  const [activeView, setActiveView] = useState<AppView>("graph");
  const [showPalette, setShowPalette] = useState(false);
  const [shouldScrollToGraph, setShouldScrollToGraph] = useState(false);
  const [analyzeRunNonce, setAnalyzeRunNonce] = useState(0);
  const [prefetchedAiInsights, setPrefetchedAiInsights] = useState<RepoAiInsightsResponse | null>(null);
  const [prefetchedAiInsightsLoading, setPrefetchedAiInsightsLoading] = useState(false);
  const [prefetchedAiInsightsError, setPrefetchedAiInsightsError] = useState<string | null>(null);
  const mainColumnRef = useRef<HTMLElement | null>(null);
  const graphSectionRef = useRef<HTMLDivElement | null>(null);
  const googleButtonRef = useRef<HTMLDivElement | null>(null);

  const deferredSearchQuery = useDeferredValue(searchQuery);
  const generatedLabel = analysis ? formatDate(analysis.summary.generatedAt) : undefined;

  useEffect(() => {
    const currentPath = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    const verificationToken = params.get("token")?.trim();

    if (currentPath !== "/verify-email" || !verificationToken) {
      return;
    }

    let cancelled = false;
    setAuthSubmitting(true);
    setAuthError(null);

    void verifyEmail({ token: verificationToken })
      .then((result) => {
        if (cancelled) {
          return;
        }

        setAuthMode("login");
        setAuthInfo(result.message);
      })
      .catch((caughtError) => {
        if (!cancelled) {
          setAuthError(caughtError instanceof Error ? caughtError.message : "Email verification failed.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAuthSubmitting(false);
          window.history.replaceState({}, "", "/");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const bootstrapAuth = async () => {
      const token = getAuthToken();
      if (!token) {
        if (!cancelled) {
          setAuthLoading(false);
        }
        return;
      }

      try {
        const user = await fetchMe();
        if (!cancelled) {
          setAuthUser(user);
        }
      } catch {
        clearAuthToken();
      } finally {
        if (!cancelled) {
          setAuthLoading(false);
        }
      }
    };

    void bootstrapAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (authUser) {
      return;
    }

    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim();
    if (!clientId) {
      setGoogleAuthError("Google sign-in is not configured for this environment.");
      setGoogleButtonVisible(false);
      return;
    }

    setGoogleAuthError(null);
    setGoogleButtonVisible(false);
    let cancelled = false;

    const tryRenderGoogleButton = (): boolean => {
      const mountPoint = googleButtonRef.current;
      const googleId = window.google?.accounts?.id;

      if (!mountPoint || !googleId) {
        return false;
      }

      try {
        mountPoint.innerHTML = "";
        googleId.initialize({
          client_id: clientId,
          callback: ({ credential }) => {
            if (!credential) {
              setGoogleAuthError("Google did not return a valid credential.");
              setAuthError("Google authentication failed.");
              return;
            }

            if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credential)) {
              setGoogleAuthError("Google returned an invalid credential. Check OAuth setup and retry.");
              setAuthError("Google authentication failed.");
              return;
            }

            setAuthSubmitting(true);
            setAuthError(null);
            setAuthInfo(null);

            void loginWithGoogle({ idToken: credential })
              .then((result) => {
                if (!cancelled) {
                  setAuthUser(result.user);
                }
              })
              .catch((caughtError) => {
                if (!cancelled) {
                  setAuthError("Google sign-in failed. Verify client IDs and authorized origins.");
                }
              })
              .finally(() => {
                if (!cancelled) {
                  setAuthSubmitting(false);
                }
              });
          }
        });

        googleId.renderButton(mountPoint, {
          theme: "outline",
          size: "large",
          shape: "pill",
          width: 320
        });

        const hasButton = mountPoint.childElementCount > 0;
        setGoogleButtonVisible(hasButton);
        setGoogleAuthError(
          hasButton ? null : "Google button did not render. Check OAuth Authorized JavaScript origins for this exact URL."
        );
        return hasButton;
      } catch {
        setGoogleAuthError("Google sign-in failed to initialize. Verify Google OAuth client origins and browser privacy settings.");
        setGoogleButtonVisible(false);
        return false;
      }
    };

    const existingScript = document.querySelector(`script[src=\"${GOOGLE_GSI_SCRIPT_SRC}\"]`) as HTMLScriptElement | null;
    let sdkPollInterval: number | null = null;
    let sdkTimeout: number | null = null;

    if (!existingScript && !window.google?.accounts?.id) {
      const script = document.createElement("script");
      script.src = GOOGLE_GSI_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onerror = () => {
        if (!cancelled) {
          setGoogleAuthError("Google sign-in is blocked in this browser. Disable blockers and retry.");
          setGoogleButtonVisible(false);
        }
      };
      document.head.appendChild(script);
    }

    sdkPollInterval = window.setInterval(() => {
      if (cancelled) {
        return;
      }

      if (tryRenderGoogleButton()) {
        if (sdkPollInterval !== null) {
          window.clearInterval(sdkPollInterval);
          sdkPollInterval = null;
        }
      }
    }, 100);

    sdkTimeout = window.setTimeout(() => {
      if (cancelled) {
        return;
      }

      if (sdkPollInterval !== null) {
        window.clearInterval(sdkPollInterval);
        sdkPollInterval = null;
      }

      if (!window.google?.accounts?.id) {
        setGoogleAuthError("Google sign-in SDK did not finish loading. Disable blockers/privacy shields and reload.");
        setGoogleButtonVisible(false);
      } else if (!tryRenderGoogleButton()) {
        setGoogleAuthError("Google button did not render. Check OAuth Authorized JavaScript origins for this exact URL.");
        setGoogleButtonVisible(false);
      }
    }, 5000);

    return () => {
      cancelled = true;
      if (sdkPollInterval !== null) {
        window.clearInterval(sdkPollInterval);
      }
      if (sdkTimeout !== null) {
        window.clearTimeout(sdkTimeout);
      }
    };
  }, [authUser]);

  useEffect(() => {
    if (!authUser) {
      setBooting(false);
      return;
    }

    let cancelled = false;

    const bootstrap = async () => {
      try {
        const health = await fetchHealth();

        if (cancelled) {
          return;
        }

        if (!source.trim() && health.defaultSource) {
          setSource(health.defaultSource);
        }

        try {
          const currentAnalysis = await fetchCurrentAnalysis();
          if (cancelled) {
            return;
          }

          hydrateAnalysis(currentAnalysis);
        } catch {
          // No prior analysis for this user is expected on first login.
        }
      } catch {
        return;
      } finally {
        if (!cancelled) {
          setBooting(false);
        }
      }
    };

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [authUser]);

  useEffect(() => {
    if (!selectedNodeId) {
      setNodeDetails(null);
      return;
    }

    let cancelled = false;
    setLoadingNode(true);

    void fetchNodeDetails(selectedNodeId)
      .then((details) => {
        if (!cancelled) {
          setNodeDetails(details);
        }
      })
      .catch((caughtError) => {
        if (!cancelled) {
          setError(caughtError instanceof Error ? caughtError.message : "Unable to load node details.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingNode(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedNodeId]);

  useEffect(() => {
    if (!analysis || !deferredSearchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    let cancelled = false;

    void searchNodes(deferredSearchQuery)
      .then((results) => {
        if (!cancelled) {
          setSearchResults(results);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSearchResults([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [analysis?.id, deferredSearchQuery]);

  useEffect(() => {
    if (!analysis) {
      setPrefetchedAiInsights(null);
      setPrefetchedAiInsightsLoading(false);
      setPrefetchedAiInsightsError(null);
      return;
    }

    let cancelled = false;
    setPrefetchedAiInsightsLoading(true);
    setPrefetchedAiInsightsError(null);

    void fetchAiInsights()
      .then((payload) => {
        if (!cancelled) {
          setPrefetchedAiInsights(payload);
        }
      })
      .catch((caughtError) => {
        if (!cancelled) {
          setPrefetchedAiInsightsError(caughtError instanceof Error ? caughtError.message : "Failed to generate AI insights.");
          setPrefetchedAiInsights(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPrefetchedAiInsightsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [analysis?.id]);

  useEffect(() => {
    if (!shouldScrollToGraph || activeView !== "graph") {
      return;
    }

    const mainColumn = mainColumnRef.current;
    const graphSection = graphSectionRef.current;
    if (!mainColumn || !graphSection) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      mainColumn.scrollTo({
        top: graphSection.offsetTop,
        behavior: "smooth"
      });
      setShouldScrollToGraph(false);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [shouldScrollToGraph, activeView, analysis?.id]);

  // Cmd+K / Ctrl+K shortcut for command palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowPalette((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleAnalyze = async () => {
    if (!source.trim()) {
      setError("Enter a local path or GitHub repository URL.");
      return;
    }

    setError(null);
    setAnalyzing(true);

    try {
      const result = await analyzeSource(source.trim());
      setAnalyzeRunNonce((current) => current + 1);
      hydrateAnalysis(result);
      setActiveView("graph");
      setShouldScrollToGraph(true);
      setSearchQuery("");
      setSearchResults([]);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Analysis failed.");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleFocusNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSearchResults([]);
  };

  const handleClearSelection = () => {
    setSelectedNodeId(null);
    setNodeDetails(null);
  };

  const navigateToLanding = (e: React.MouseEvent) => {
    e.preventDefault();
    window.history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  const statusMessage = booting
    ? "Checking for an existing analysis..."
    : error
      ? error
      : analysis
        ? `${analysis.summary.counts.nodes} nodes loaded from ${analysis.summary.repoName}.`
        : "Ready for the first analysis.";
  const userInitials = (authUser?.email ?? "")
    .split("@")[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "U";

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authEmail.trim() || !authPassword.trim()) {
      setAuthError("Email and password are required.");
      return;
    }

    setAuthSubmitting(true);
    setAuthError(null);

    try {
      if (authMode === "register") {
        const normalizedEmail = authEmail.trim().toLowerCase();
        const result = await register({ email: normalizedEmail, password: authPassword });
        setPendingVerificationEmail(normalizedEmail);
        setAuthMode("login");
        setAuthInfo(result.message);
      } else {
        const result = await login({ email: authEmail.trim(), password: authPassword });
        setAuthUser(result.user);
        setAuthInfo(null);
        setPendingVerificationEmail(null);
      }
      setAuthPassword("");
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Authentication failed.";
      setAuthError(message);

      if (authMode === "login" && /verify your email/i.test(message)) {
        setPendingVerificationEmail(authEmail.trim().toLowerCase());
      }
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleResendVerification = async () => {
    if (!pendingVerificationEmail) {
      return;
    }

    setAuthSubmitting(true);
    setAuthError(null);
    try {
      const response = await requestEmailVerification({ email: pendingVerificationEmail });
      setAuthInfo(response.message);
    } catch (caughtError) {
      setAuthError(caughtError instanceof Error ? caughtError.message : "Unable to resend verification email.");
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleLogout = () => {
    clearAuthToken();
    setAuthUser(null);
    setAnalysis(null);
    setNodeDetails(null);
    setSelectedNodeId(null);
    setSearchQuery("");
    setSearchResults([]);
    setError(null);
  };

  if (authLoading) {
    return (
      <main className="app-shell">
        <section className="auth-shell panel">
          <h1>RepoGraph</h1>
          <p className="auth-subtitle">Checking session...</p>
        </section>
      </main>
    );
  }

  if (!authUser) {
    return (
      <main className="app-shell auth-page">
        <section className="auth-shell panel">
          <p className="panel-title">Secure Access</p>
          <h1>{authMode === "register" ? "Create your workspace account" : "Sign in to RepoGraph"}</h1>

          <div className="auth-google-wrap">
            <div ref={googleButtonRef} />
          </div>
          {!googleButtonVisible && !googleAuthError && (
            <p className="auth-info">Preparing Google sign-in...</p>
          )}
          {googleAuthError && <p className="auth-error">{googleAuthError}</p>}

          <div className="auth-divider" aria-hidden="true">or use email</div>

          <form className="auth-form" onSubmit={handleAuthSubmit}>
            <label>
              Email
              <input
                type="email"
                value={authEmail}
                onChange={(event) => setAuthEmail(event.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
                maxLength={320}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
              />
            </label>

            <label>
              Password
              <input
                type="password"
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
                placeholder="At least 8 characters"
                autoComplete={authMode === "register" ? "new-password" : "current-password"}
                minLength={8}
                maxLength={128}
                required
              />
            </label>

            {authInfo && <p className="auth-info">{authInfo}</p>}
            {authError && <p className="auth-error">{authError}</p>}

            <button type="submit" className="auth-submit" disabled={authSubmitting}>
              {authSubmitting ? "Working..." : authMode === "register" ? "Create account" : "Sign in"}
            </button>
          </form>

          <div className="auth-switcher">
            <span>{authMode === "register" ? "Already have an account?" : "Need an account?"}</span>
            <button
              type="button"
              className="auth-switch"
              onClick={() => {
                setAuthError(null);
                setAuthInfo(null);
                setAuthMode((current) => (current === "login" ? "register" : "login"));
              }}
            >
              {authMode === "register" ? "Sign in" : "Create one"}
            </button>
          </div>

          {pendingVerificationEmail && (
            <div className="auth-switcher">
              <span>Need a new verification email?</span>
              <button
                type="button"
                className="auth-switch"
                onClick={() => {
                  void handleResendVerification();
                }}
                disabled={authSubmitting}
              >
                Resend
              </button>
            </div>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="panel top-nav">
        <button type="button" className="top-nav-brand" onClick={navigateToLanding}>
          <span className="top-nav-logo-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="top-nav-logo-text">RepoGraph</span>
        </button>

        <nav className="top-nav-links" aria-label="Primary">
          {(Object.keys(VIEW_LABELS) as AppView[]).map((view) => (
            <button
              key={view}
              type="button"
              className={`top-nav-link ${activeView === view ? "top-nav-link-active" : ""}`}
              onClick={() => setActiveView(view)}
            >
              {VIEW_LABELS[view]}
            </button>
          ))}
        </nav>

        <div className="top-nav-user">
          <button type="button" className="top-nav-profile" title={authUser.email}>
            <span className="top-nav-avatar">{userInitials}</span>
            <span className="top-nav-email">{authUser.email}</span>
          </button>
          <button type="button" className="top-nav-logout" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </header>

      {showPalette && (
        <CommandPalette
          analysis={analysis}
          onFocusNode={(nodeId) => {
            handleFocusNode(nodeId);
            setActiveView("graph");
          }}
          onSwitchView={(view) => setActiveView(view as AppView)}
          onClose={() => setShowPalette(false)}
        />
      )}

      <div className="app-grid">
        <SummarySidebar analysis={analysis} onFocusNode={handleFocusNode} />

        <section className="main-column" ref={mainColumnRef}>
          <ControlBar
            source={source}
            onSourceChange={setSource}
            onAnalyze={handleAnalyze}
            analyzing={analyzing}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            searchResults={searchResults}
            onSelectSearchResult={handleFocusNode}
            lastGeneratedAt={generatedLabel}
            onNavigateHome={navigateToLanding}
            onOpenPalette={() => setShowPalette(true)}
          />

          <div className="banner">{statusMessage}</div>

          {activeView === "graph" && (
            <div ref={graphSectionRef}>
              <GraphCanvas
                analysis={analysis}
                selectedNodeId={selectedNodeId}
                onSelectNode={handleFocusNode}
                onClearSelection={handleClearSelection}
                revealOnAnalyzeNonce={analyzeRunNonce}
              />
            </div>
          )}

          {activeView === "explorer" && (
            <FileExplorer analysis={analysis} onFocusNode={handleFocusNode} />
          )}

          {activeView === "stats" && <StatsView analysis={analysis} />}

          {activeView === "insights" && (
            <InsightsExplorer
              analysis={analysis}
              onFocusNode={handleFocusNode}
              prefetchedAiInsights={prefetchedAiInsights}
              prefetchedAiInsightsLoading={prefetchedAiInsightsLoading}
              prefetchedAiInsightsError={prefetchedAiInsightsError}
            />
          )}

          {activeView === "dependencies" && (
            <DependencyTree analysis={analysis} onFocusNode={handleFocusNode} />
          )}

          {activeView === "contributors" && (
            <ContributorView analysis={analysis} onFocusNode={handleFocusNode} />
          )}

        </section>

        <NodePanel details={nodeDetails} loading={loadingNode} onFocusNode={handleFocusNode} />
      </div>

      <RepoChatbot analysis={analysis} />
    </main>
  );

  function hydrateAnalysis(result: AnalysisResult) {
    startTransition(() => {
      setAnalysis(result);
      setSource(result.summary.source);
      setSelectedNodeId(null);
      setNodeDetails(null);
      setError(null);
    });
  }
}
