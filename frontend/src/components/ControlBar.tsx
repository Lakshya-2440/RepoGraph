import type { SearchResult } from "@shared/index";

interface ControlBarProps {
  source: string;
  onSourceChange: (value: string) => void;
  onAnalyze: () => void;
  analyzing: boolean;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  searchResults: SearchResult[];
  onSelectSearchResult: (nodeId: string) => void;
  lastGeneratedAt?: string;
  onNavigateHome?: (e: React.MouseEvent) => void;
  onOpenPalette?: () => void;
}

export function ControlBar(props: ControlBarProps) {
  return (
    <section className="panel control-bar">
      <div className="control-bar-top">
        <div className="eyebrow">Living Map + Mini Agents</div>
        <div className="control-bar-top-actions">
          {props.onOpenPalette && (
            <button type="button" className="cmd-k-btn" onClick={props.onOpenPalette}>
              <kbd>{navigator.platform?.includes("Mac") ? "\u2318" : "Ctrl+"}K</kbd>
            </button>
          )}
          {props.onNavigateHome && (
            <a href="/" onClick={props.onNavigateHome} className="home-link">
              &larr; Home
            </a>
          )}
        </div>
      </div>
      <div className="hero-title">GitHub Repo Knowledge Graph</div>
      <p className="hero-copy">
        Analyze a local path or a GitHub repository URL, then inspect structure, dependencies, git history,
        and agent-style insights in one moving graph.
      </p>

      <div className="input-group">
        <label htmlFor="repo-source">Repo source</label>
        <div className="input-row">
          <input
            id="repo-source"
            type="text"
            maxLength={2048}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={props.source}
            onChange={(event) => props.onSourceChange(event.target.value)}
            placeholder="/absolute/path/to/repo or https://github.com/owner/repo"
          />
          <button type="button" onClick={props.onAnalyze} disabled={props.analyzing}>
            {props.analyzing ? "Analyzing..." : "Analyze"}
          </button>
        </div>
        <div className="microcopy">
          Works with local folders and public GitHub repos.
        </div>
      </div>

      <div className="input-group search-group">
        <label htmlFor="graph-search">Search the graph</label>
        <input
          id="graph-search"
          type="search"
          maxLength={200}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={props.searchQuery}
          onChange={(event) => props.onSearchQueryChange(event.target.value)}
          placeholder="file, directory, function, dependency"
        />

        {props.searchQuery.trim() ? (
          <div className="search-results">
            {props.searchResults.length > 0 ? (
              props.searchResults.map((result) => (
                <button
                  type="button"
                  key={result.id}
                  className="search-result"
                  onClick={() => props.onSelectSearchResult(result.id)}
                >
                  <span>{result.label}</span>
                  <small>{result.path ?? result.type}</small>
                </button>
              ))
            ) : (
              <div className="search-empty">No matching nodes.</div>
            )}
          </div>
        ) : null}
      </div>

      <div className="status-row">
        <span className="status-pill">Force-directed graph</span>
        <span className="status-pill">Rule-based insights</span>
        {props.lastGeneratedAt ? <span className="status-pill">Updated {props.lastGeneratedAt}</span> : null}
      </div>
    </section>
  );
}
