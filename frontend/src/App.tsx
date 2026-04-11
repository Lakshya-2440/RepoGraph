import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";

import type { AnalysisResult, NodeDetailResponse, RepoAiInsightsResponse, SearchResult } from "@shared/index";

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
import { analyzeSource, fetchAiInsights, fetchCurrentAnalysis, fetchHealth, fetchNodeDetails, searchNodes } from "./lib/api";
import { formatDate } from "./lib/format";

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

  const deferredSearchQuery = useDeferredValue(searchQuery);
  const generatedLabel = analysis ? formatDate(analysis.summary.generatedAt) : undefined;

  useEffect(() => {
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
  }, []);

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
