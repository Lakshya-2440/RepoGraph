import { useCallback, useEffect, useState } from "react";

import type { AiRepoInsight, AnalysisResult, RepoAiInsightsResponse } from "@shared/index";

import { fetchAiInsights } from "../lib/api";

interface InsightsExplorerProps {
  analysis: AnalysisResult | null;
  onFocusNode: (nodeId: string) => void;
  prefetchedAiInsights?: RepoAiInsightsResponse | null;
  prefetchedAiInsightsLoading?: boolean;
  prefetchedAiInsightsError?: string | null;
}

export function InsightsExplorer({
  analysis,
  onFocusNode,
  prefetchedAiInsights,
  prefetchedAiInsightsLoading,
  prefetchedAiInsightsError
}: InsightsExplorerProps) {
  const [aiInsights, setAiInsights] = useState<AiRepoInsight[]>([]);
  const [aiGeneratedAt, setAiGeneratedAt] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const generateInsights = useCallback(async () => {
    if (!analysis) {
      return;
    }

    setAiError(null);
    setAiLoading(true);

    try {
      const payload = await fetchAiInsights();
      setAiInsights(payload.insights);
      setAiGeneratedAt(payload.generatedAt);
    } catch (caughtError) {
      setAiError(caughtError instanceof Error ? caughtError.message : "Failed to generate AI insights.");
    } finally {
      setAiLoading(false);
    }
  }, [analysis?.id]);

  useEffect(() => {
    if (!analysis) {
      setAiInsights([]);
      setAiGeneratedAt(null);
      setAiError(null);
      setAiLoading(false);
      return;
    }

    if (prefetchedAiInsights?.insights?.length) {
      setAiInsights(prefetchedAiInsights.insights);
      setAiGeneratedAt(prefetchedAiInsights.generatedAt);
      setAiError(null);
      setAiLoading(false);
      return;
    }

    if (prefetchedAiInsightsError) {
      setAiError(prefetchedAiInsightsError);
    }

    if (prefetchedAiInsightsLoading) {
      setAiLoading(true);
      return;
    }

    void generateInsights();
  }, [analysis?.id, prefetchedAiInsights, prefetchedAiInsightsError, prefetchedAiInsightsLoading, generateInsights]);

  if (!analysis) {
    return (
      <section className="panel ie-panel">
        <div className="panel-title">Insights</div>
        <p className="empty-state">Run an analysis to view insights.</p>
      </section>
    );
  }

  return (
    <section className="panel ie-panel">
      <div className="ie-header">
        <div className="panel-title">AI Insights</div>
        <span className="ie-count">{aiLoading ? "Analyzing..." : `${aiInsights.length} insights`}</span>
      </div>

      {aiGeneratedAt ? <div className="ie-count">Updated {new Date(aiGeneratedAt).toLocaleTimeString()}</div> : null}

      {aiError ? <p className="ie-ai-error">{aiError}</p> : null}

      {aiInsights.length > 0 ? (
        <div className="ie-ai-list">
          <div className="ie-ai-title-row">
            <strong>AI insights</strong>
          </div>
          {aiInsights.map((insight) => (
            <button
              key={insight.id}
              type="button"
              className={`ie-card insight-card ${insight.kind}`}
              onClick={() => {
                if (insight.nodeId) {
                  onFocusNode(insight.nodeId);
                }
              }}
            >
              <div className="ie-card-header">
                <strong>{insight.title}</strong>
                <span className={`ie-kind-badge ie-kind-${insight.kind}`}>{insight.kind}</span>
              </div>
              <span className="ie-card-message">{insight.message}</span>
              <div className="ie-card-footer">
                <span className="ie-card-node">
                  Confidence {insight.confidence}
                  {insight.nodeLabel ? ` · ${insight.nodeLabel}` : ""}
                </span>
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
