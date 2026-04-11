import { useEffect, useState } from "react";

import type { AnalysisResult, ChatMessage } from "@shared/index";

import { askRepoQuestion } from "../lib/api";

interface RepoChatbotProps {
  analysis: AnalysisResult | null;
}

type UiMessage = ChatMessage;

export function RepoChatbot({ analysis }: RepoChatbotProps) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!analysis) {
      setMessages([]);
      setQuestion("");
      setError(null);
    }
  }, [analysis?.id]);

  const trimmedQuestion = question.trim();
  const canAsk = Boolean(analysis) && trimmedQuestion.length > 0 && !sending;

  const submit = async () => {
    if (!analysis || !trimmedQuestion || sending) {
      return;
    }

    setError(null);
    setSending(true);

    const userMessage: UiMessage = { role: "user", content: trimmedQuestion };
    setMessages((current) => [...current, userMessage]);

    const history = [...messages, userMessage].map((message) => ({
      role: message.role,
      content: message.content
    }));

    try {
      const result = await askRepoQuestion(trimmedQuestion, history);
      const assistantMessage: UiMessage = {
        role: "assistant",
        content: result.answer
      };
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
      {open ? (
        <section className="panel chat-panel chat-floating-window">
          <div className="chat-header-row">
            <div>
              <div className="panel-title">Repo AI Chat</div>
            </div>
            <button type="button" className="graph-toggle" onClick={() => setOpen(false)}>
              x
            </button>
          </div>

          <div className="chat-messages" aria-live="polite">
            {!analysis ? (
              <div className="chat-empty">Run analysis first, then ask any question about the repository.</div>
            ) : messages.length === 0 ? (
              <div className="chat-empty">Ask anything about this repository.</div>
            ) : (
              messages.map((message, index) => (
                <article key={`${message.role}-${index}`} className={`chat-message ${message.role}`}>
                  <header>
                    <strong>{message.role === "assistant" ? "Assistant" : "You"}</strong>
                  </header>
                  <p>{message.content}</p>
                </article>
              ))
            )}
          </div>

          <div className="chat-input-row">
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Ask anything about this repository..."
              rows={3}
              disabled={!analysis || sending}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="chat-actions">
              <button type="button" className="graph-toggle" disabled={!canAsk} onClick={() => void submit()}>
                {sending ? "Thinking..." : "Ask"}
              </button>
            </div>
          </div>

          {error ? <div className="chat-error">{error}</div> : null}
        </section>
      ) : null}

      <button
        type="button"
        className="chat-fab"
        onClick={() => setOpen((current) => !current)}
        aria-label={open ? "Close AI chat" : "Open AI chat"}
      >
        +
      </button>
    </div>
  );
}
