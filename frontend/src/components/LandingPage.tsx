import { useEffect, useRef, useState } from "react";
import "../landing.css";

const GRAPH_COLORS = [
  "#ff6b2c", "#0f766e", "#174a72", "#d45500", "#8b5cf6",
  "#ef4444", "#64748b", "#22c55e", "#f59e0b", "#14b8a6"
];

const FEATURES = [
  {
    icon: "\u25CE",
    title: "Living Force Graph",
    description: "Interactive force-directed visualization with drag, zoom, spotlight mode, and pinning. Every connection in your codebase rendered in real time."
  },
  {
    icon: "\u2B21",
    title: "Full AST Extraction",
    description: "Functions, classes, methods, variables, imports, types \u2014 parsed from every JS/TS file via Babel with full call-graph and inheritance edges."
  },
  {
    icon: "\u25C8",
    title: "Git Archaeology",
    description: "Up to 120 commits traced. Every file mapped to authors, timestamps, and change frequency. Instantly see who owns what code."
  },
  {
    icon: "\u25C7",
    title: "Dependency Intelligence",
    description: "Production and dev dependencies mapped. Import chains fully resolved. Circular references, orphan modules, and bottlenecks surfaced."
  },
  {
    icon: "\u25C9",
    title: "AI Mini-Agents",
    description: "Rule-based insight engines that detect bottlenecks, hubs, orphans, hot files, stale code, missing tests, and ownership patterns."
  },
  {
    icon: "\u2B22",
    title: "GitHub Integration",
    description: "Issues, pull requests, comments, stars, forks \u2014 pulled from the GitHub API and woven directly into the graph topology."
  }
];

const STEPS = [
  {
    number: "01",
    title: "Paste a source",
    description: "Drop a GitHub URL or local filesystem path. Public repos work instantly. Set GITHUB_TOKEN for private repos and higher API limits."
  },
  {
    number: "02",
    title: "We analyze everything",
    description: "File tree walking, Babel AST parsing, git log extraction, GitHub API fetching, dependency resolution, metrics computation, and insight generation \u2014 all automatic."
  },
  {
    number: "03",
    title: "Explore the knowledge graph",
    description: "Navigate an interactive force-directed graph. Search any symbol. Filter by type. Inspect insights. Browse files. Understand your codebase completely."
  }
];

const NODE_TYPE_SHOWCASE = [
  { type: "File", color: "#174a72", count: "Every source file" },
  { type: "Function", color: "#d45500", count: "All declarations" },
  { type: "Class", color: "#8b5cf6", count: "With methods" },
  { type: "Import", color: "#f97316", count: "Resolved chains" },
  { type: "Dependency", color: "#ef4444", count: "npm packages" },
  { type: "Commit", color: "#64748b", count: "Git history" },
  { type: "User", color: "#22c55e", count: "Contributors" },
  { type: "Issue", color: "#dc2626", count: "GitHub issues" },
  { type: "PullRequest", color: "#16a34a", count: "Open PRs" },
  { type: "Type", color: "#14b8a6", count: "TS interfaces" },
  { type: "Variable", color: "#8b5e34", count: "Exports" },
  { type: "Directory", color: "#0f766e", count: "Folder tree" }
];

interface Particle {
  x: number;
  y: number;
  originX: number;
  originY: number;
  radius: number;
  color: string;
  angle: number;
  speed: number;
  orbitRadius: number;
}

function createParticles(width: number, height: number): Particle[] {
  const particles: Particle[] = [];
  const cx = width / 2;
  const cy = height / 2;
  const count = 55;

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.8;
    const distance = 50 + Math.random() * Math.min(width, height) * 0.38;
    const x = cx + Math.cos(angle) * distance;
    const y = cy + Math.sin(angle) * distance;

    particles.push({
      x,
      y,
      originX: x,
      originY: y,
      radius: 1.8 + Math.random() * 3.5,
      color: GRAPH_COLORS[Math.floor(Math.random() * GRAPH_COLORS.length)],
      angle: Math.random() * Math.PI * 2,
      speed: 0.002 + Math.random() * 0.004,
      orbitRadius: 6 + Math.random() * 18
    });
  }

  return particles;
}

export function LandingPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const [revealedSections, setRevealedSections] = useState<Set<string>>(new Set());

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = entry.target.getAttribute("data-reveal");
            if (id) {
              setRevealedSections((prev) => new Set([...prev, id]));
            }
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -50px 0px" }
    );

    document.querySelectorAll("[data-reveal]").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = rect?.width ?? 800;
      const h = rect?.height ?? 500;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      particlesRef.current = createParticles(w, h);
    };

    resize();
    window.addEventListener("resize", resize);

    let frame: number;
    const edgeDistance = 130;

    const animate = () => {
      const w = canvas.width / (window.devicePixelRatio || 1);
      const h = canvas.height / (window.devicePixelRatio || 1);

      ctx.clearRect(0, 0, w, h);

      const particles = particlesRef.current;

      for (const p of particles) {
        p.angle += p.speed;
        p.x = p.originX + Math.cos(p.angle) * p.orbitRadius;
        p.y = p.originY + Math.sin(p.angle * 0.7) * p.orbitRadius;
      }

      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < edgeDistance) {
            const opacity = (1 - dist / edgeDistance) * 0.18;
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(232, 168, 56, ${opacity})`;
            ctx.lineWidth = 0.6;
            ctx.stroke();
          }
        }
      }

      for (const p of particles) {
        const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius * 5);
        glow.addColorStop(0, p.color + "30");
        glow.addColorStop(1, p.color + "00");
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius * 5, 0, Math.PI * 2);
        ctx.fillStyle = glow;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
      }

      const vignette = ctx.createRadialGradient(w / 2, h / 2, w * 0.2, w / 2, h / 2, w * 0.56);
      vignette.addColorStop(0, "rgba(14, 16, 18, 0)");
      vignette.addColorStop(1, "rgba(14, 16, 18, 0.92)");
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, w, h);

      frame = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, []);

  const isRevealed = (id: string) => revealedSections.has(id);

  const navigateToApp = (e: React.MouseEvent) => {
    e.preventDefault();
    window.history.pushState({}, "", "/app");
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  return (
    <div className="lp">
      <div className="lp-grain" />
      <div className="lp-grid-bg" />

      <nav className="lp-nav">
        <div className="lp-nav-brand">
          <div className="lp-logo-mark">
            <span />
            <span />
            <span />
          </div>
          <span className="lp-logo-text">RepoGraph</span>
        </div>
        <div className="lp-nav-links">
          <a href="#features">Features</a>
          <a href="#workflow">How it works</a>
          <a href="#coverage">Coverage</a>
          <a href="/app" onClick={navigateToApp} className="lp-nav-cta">
            Launch App <span className="lp-arrow">&rarr;</span>
          </a>
        </div>
      </nav>

      <section className="lp-hero">
        <div className="lp-hero-content">
          <div className="lp-hero-badge">
            <span className="lp-badge-dot" />
            Open-source repository intelligence
          </div>
          <h1 className="lp-hero-title">
            See <em>everything</em>
            <br />
            inside your repository
          </h1>
          <p className="lp-hero-sub">
            Map every file, function, dependency, commit, and contributor into one living, searchable knowledge graph.
            Understand any codebase in seconds.
          </p>
          <div className="lp-hero-actions">
            <a href="/app" onClick={navigateToApp} className="lp-btn lp-btn-primary">
              Launch App
              <span className="lp-btn-shine" />
            </a>
            <a href="#features" className="lp-btn lp-btn-ghost">
              Explore features
            </a>
          </div>
        </div>

        <div className="lp-hero-visual">
          <div className="lp-graph-container">
            <canvas ref={canvasRef} />
            <div className="lp-graph-badge lp-graph-badge-1">
              <strong>16</strong>
              <span>node types</span>
            </div>
            <div className="lp-graph-badge lp-graph-badge-2">
              <strong>19</strong>
              <span>relationships</span>
            </div>
            <div className="lp-graph-badge lp-graph-badge-3">
              <strong>&lt;2s</strong>
              <span>analysis</span>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-section" id="features" data-reveal="features">
        <div className={`lp-section-inner ${isRevealed("features") ? "revealed" : ""}`}>
          <div className="lp-section-header">
            <span className="lp-section-label">01 &mdash; Capabilities</span>
            <h2 className="lp-section-title">
              One graph.
              <br />
              Complete understanding.
            </h2>
            <p className="lp-section-sub">
              Every layer of your codebase &mdash; structure, code, dependencies, git history, and GitHub metadata
              &mdash; unified in a single interactive visualization.
            </p>
          </div>

          <div className="lp-feature-grid">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="lp-feature-card">
                <div className="lp-feature-icon">{feature.icon}</div>
                <h3>{feature.title}</h3>
                <p>{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section lp-section-alt" id="workflow" data-reveal="workflow">
        <div className={`lp-section-inner ${isRevealed("workflow") ? "revealed" : ""}`}>
          <div className="lp-section-header">
            <span className="lp-section-label">02 &mdash; Workflow</span>
            <h2 className="lp-section-title">
              Three steps to
              <br />
              total clarity
            </h2>
          </div>

          <div className="lp-steps">
            {STEPS.map((step) => (
              <div key={step.number} className="lp-step">
                <div className="lp-step-number">{step.number}</div>
                <div className="lp-step-content">
                  <h3>{step.title}</h3>
                  <p>{step.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section" id="coverage" data-reveal="coverage">
        <div className={`lp-section-inner ${isRevealed("coverage") ? "revealed" : ""}`}>
          <div className="lp-section-header">
            <span className="lp-section-label">03 &mdash; Coverage</span>
            <h2 className="lp-section-title">
              Every layer of your
              <br />
              codebase, mapped
            </h2>
            <p className="lp-section-sub">
              From individual functions to repository-wide patterns. Every entity becomes a node. Every relationship
              becomes an edge.
            </p>
          </div>

          <div className="lp-node-grid">
            {NODE_TYPE_SHOWCASE.map((item) => (
              <div key={item.type} className="lp-node-card">
                <div className="lp-node-dot" style={{ backgroundColor: item.color, boxShadow: `0 0 10px ${item.color}` }} />
                <div className="lp-node-info">
                  <strong>{item.type}</strong>
                  <span>{item.count}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-cta" data-reveal="cta">
        <div className={`lp-cta-inner ${isRevealed("cta") ? "revealed" : ""}`}>
          <div className="lp-cta-glow" />
          <h2>
            Ready to understand
            <br />
            your codebase?
          </h2>
          <p>Paste a GitHub URL. Get a knowledge graph. Zero configuration.</p>
          <a href="/app" onClick={navigateToApp} className="lp-btn lp-btn-primary lp-btn-lg">
            Launch the App
            <span className="lp-btn-shine" />
          </a>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <div className="lp-footer-brand">
            <div className="lp-logo-mark">
              <span />
              <span />
              <span />
            </div>
            <span>RepoGraph</span>
          </div>
          <div className="lp-footer-text">
            Open-source repository intelligence.
            <br />
            Built for developers who need to see the big picture.
          </div>
        </div>
      </footer>
    </div>
  );
}
