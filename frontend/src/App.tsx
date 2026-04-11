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
  register,
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
          renderButton: (parent: HTMLElement, options: { theme?: string; size?: string; width?: number }) => void;
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

export function App() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authInfo, setAuthInfo] = useState<string | null>(null);
  const [googleAuthError, setGoogleAuthError] = useState<string | null>(null);
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
      return;
    }

    if (!googleButtonRef.current) {
      return;
    }

    setGoogleAuthError(null);
    let cancelled = false;

    const renderGoogleButton = () => {
      if (cancelled || !window.google?.accounts?.id || !googleButtonRef.current) {
        if (!cancelled) {
          setGoogleAuthError("Google sign-in SDK could not be loaded.");
        }
        return;
      }

      googleButtonRef.current.innerHTML = "";
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: ({ credential }) => {
          if (!credential) {
            setGoogleAuthError("Google did not return a valid credential.");
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
                setAuthError(caughtError instanceof Error ? caughtError.message : "Google sign-in failed.");
              }
            })
            .finally(() => {
              if (!cancelled) {
                setAuthSubmitting(false);
              }
            });
        }
      });
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        theme: "outline",
        size: "large",
        width: 320
      });
      setGoogleAuthError(null);
    };

    if (window.google?.accounts?.id) {
      renderGoogleButton();
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = renderGoogleButton;
    script.onerror = () => {
      if (!cancelled) {
        setGoogleAuthError("Google sign-in is blocked in this browser. Disable blockers and retry.");
      }
    };
    document.head.appendChild(script);

    return () => {
      cancelled = true;
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

        if (health.hasAnalysis) {
          const currentAnalysis = await fetchCurrentAnalysis();
          if (cancelled) {
            return;
          }

          hydrateAnalysis(currentAnalysis);
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
        const result = await register({ email: authEmail.trim(), password: authPassword });
        setAuthInfo(result.message);
      } else {
        const result = await login({ email: authEmail.trim(), password: authPassword });
        setAuthUser(result.user);
        setAuthInfo(null);
      }
      setAuthPassword("");
    } catch (caughtError) {
      setAuthError(caughtError instanceof Error ? caughtError.message : "Authentication failed.");
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
          <p className="auth-subtitle">Your projects and AI activity are stored per account.</p>

          <div className="auth-google-wrap">
            <div ref={googleButtonRef} />
          </div>
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
                setAuthMode((current) => (current === "login" ? "register" : "login"));
              }}
            >
              {authMode === "register" ? "Sign in" : "Create one"}
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
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

          <div className="session-banner">
            <span>Signed in as {authUser.email}</span>
            <button type="button" className="session-logout" onClick={handleLogout}>
              Logout
            </button>
          </div>

          <div className="banner">{statusMessage}</div>

          <div className="view-tabs">
            {(Object.keys(VIEW_LABELS) as AppView[]).map((view) => (
              <button
                key={view}
                type="button"
                className={`view-tab ${activeView === view ? "view-tab-active" : ""}`}
                onClick={() => setActiveView(view)}
              >
                {VIEW_LABELS[view]}
              </button>
            ))}
          </div>

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
