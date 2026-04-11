import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import { LandingPage } from "./components/LandingPage";
import "./styles.css";

function Root() {
  const [page, setPage] = useState<"landing" | "app">(
    window.location.pathname.startsWith("/app") ? "app" : "landing"
  );

  useEffect(() => {
    const handlePopState = () => {
      setPage(window.location.pathname.startsWith("/app") ? "app" : "landing");
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  if (page === "app") {
    return <App />;
  }

  return <LandingPage />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
