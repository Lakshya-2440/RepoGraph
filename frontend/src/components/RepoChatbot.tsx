import { useEffect, useRef, useState } from "react";

import type { AnalysisResult, ChatMessage } from "@shared/index";

import { askRepoQuestion, openRouterChatCompletions } from "../lib/api";

interface RepoChatbotProps {
  analysis: AnalysisResult | null;
}

type UiMessage = ChatMessage;

export function RepoChatbot({ analysis }: RepoChatbotProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"repo" | "model">("repo");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!analysis) {
      setMessages([]);
      setQuestion("");
      setError(null);
    }
  }, [analysis?.id]);

  useEffect(() => {
    if (!open) {
      return;
    }

    bottomAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, sending, open]);

  const trimmedQuestion = question.trim();
  const canAsk = trimmedQuestion.length > 0 && !sending && (mode === "model" || Boolean(analysis));

  const submit = async () => {
    if (!trimmedQuestion || sending) {
      return;
    }
    if (mode === "repo" && !analysis) {
      return;
    }

    setError(null);
    setSending(true);

    const userMessage: UiMessage = { role: "user", content: trimmedQuestion };
    setMessages((current) => [...current, userMessage]);

    const history = [...messages, userMessage].map((message) => {
      const candidate: { role: "user" | "assistant"; content: string; reasoning_details?: unknown } = {
        role: message.role,
        content: message.content
      };
      if (message.role === "assistant" && "reasoning_details" in message) {
        candidate.reasoning_details = (message as { reasoning_details?: unknown }).reasoning_details;
      }
      return candidate;
    });

    try {
      const assistantMessage: UiMessage = mode === "repo"
        ? await submitRepo(trimmedQuestion, history)
        : await submitModel(history);
      setMessages((current) => [...current, assistantMessage]);
      setQuestion("");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to get an answer.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="chat-floating-root">
      <section
        className={`panel chat-panel chat-floating-window ${open ? "is-open" : "is-closed"}`}
        aria-hidden={!open}
      >
        <div className="chat-header-row">
          <div className="chat-header-copy">
            <div className="chat-title">{mode === "repo" ? "Repo Graph AI" : "OpenRouter Chat"}</div>
            <div className="chat-subtitle">
              {mode === "repo" ? "Grounded answers from your analyzed repo." : "Direct model chat (reasoning continuation enabled)."}
            </div>
          </div>
          <button
            type="button"
            className="graph-toggle"
            onClick={() => setMode((current) => (current === "repo" ? "model" : "repo"))}
            title={mode === "repo" ? "Switch to model chat" : "Switch to repo chat"}
          >
            {mode === "repo" ? "Model" : "Repo"}
          </button>
          <button type="button" className="graph-toggle" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>

        <div className="chat-messages" aria-live="polite">
          {mode === "repo" && !analysis ? (
            <div className="chat-empty">Run analysis first, then ask any question about the repository. Or switch to Model mode.</div>
          ) : messages.length === 0 ? (
            <div className="chat-empty">
              {mode === "repo" ? "Ask anything about this repository." : "Ask anything. This uses your OpenRouter key on the backend."}
            </div>
          ) : (
            messages.map((message, index) => (
              <article key={`${message.role}-${index}`} className={`chat-message ${message.role}`}>
                <header className="chat-message-meta">
                  <strong>{message.role === "assistant" ? "AI Assistant" : "You"}</strong>
                </header>
                <p>{message.content}</p>
              </article>
            ))
          )}
          <div ref={bottomAnchorRef} />
        </div>

        <div className="chat-input-row">
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={mode === "repo" ? "Ask anything about this repository..." : "Ask anything..."}
            rows={3}
            maxLength={2000}
            disabled={(mode === "repo" && !analysis) || sending}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="chat-actions">
            <button type="button" className="chat-send" disabled={!canAsk} onClick={() => void submit()}>
              {sending ? "Thinking..." : "Send"}
            </button>
          </div>
        </div>

        {error ? <div className="chat-error">{error}</div> : null}
      </section>

      {!open ? (
        <button type="button" className="chat-fab" onClick={() => setOpen(true)} aria-label="Open AI chat">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
            <path
              d="M12 3C6.477 3 2 6.784 2 11.45c0 2.374 1.165 4.518 3.04 6.06-.151 1.63-.852 3.1-2.01 4.29a.5.5 0 0 0 .45.84c2.49-.31 4.33-1.1 5.66-2.05A11.52 11.52 0 0 0 12 20.9c5.523 0 10-3.784 10-8.45S17.523 3 12 3Zm0 1.5c4.721 0 8.5 3.167 8.5 6.95S16.721 18.4 12 18.4a10.05 10.05 0 0 1-2.94-.43.75.75 0 0 0-.67.11c-.8.56-1.82 1.08-3.13 1.44.62-.98 1-2.1 1.1-3.3a.75.75 0 0 0-.29-.66C4.45 14.3 3.5 12.93 3.5 11.45 3.5 7.667 7.279 4.5 12 4.5Z"
              fill="currentColor"
            />
            <path
              d="M8.25 10.5a.75.75 0 0 1 .75-.75h6a.75.75 0 0 1 0 1.5H9a.75.75 0 0 1-.75-.75Zm0 3.25A.75.75 0 0 1 9 13h4a.75.75 0 0 1 0 1.5H9a.75.75 0 0 1-.75-.75Z"
              fill="currentColor"
            />
          </svg>
        </button>
      ) : null}
    </div>
  );

  async function submitRepo(trimmed: string, history: Array<{ role: "user" | "assistant"; content: string }>): Promise<UiMessage> {
    const result = await askRepoQuestion(trimmed, history);
    return { role: "assistant", content: result.answer };
  }

  async function submitModel(
    history: Array<{ role: "user" | "assistant"; content: string; reasoning_details?: unknown }>
  ): Promise<UiMessage> {
    const payload = await openRouterChatCompletions({
      model: "minimax/minimax-m2.5:free",
      messages: history,
      reasoning: { enabled: true }
    });

    const message = (payload as { choices?: Array<{ message?: { content?: string; reasoning_details?: unknown } }> }).choices?.[0]?.message;
    const content = message?.content?.trim();
    if (!content) {
      throw new Error("OpenRouter returned an empty message.");
    }

    return {
      role: "assistant",
      content,
      reasoning_details: message?.reasoning_details
    };
  }
}
