"use client";

import { useState } from "react";
import type { AskResponse } from "@/lib/types";

interface Props {
  onAsk: (question: string) => Promise<AskResponse>;
  onClear: () => void;
  disabled: boolean;
}

export default function AskBox({ onAsk, onClear, disabled }: Props) {
  const [question, setQuestion] = useState("How does creating a user work?");
  const [response, setResponse] = useState<AskResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await onAsk(question.trim());
      setResponse(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ask failed");
    } finally {
      setLoading(false);
    }
  };

  const handleClear = () => {
    setResponse(null);
    setError(null);
    onClear();
  };

  return (
    <div className="w-full">
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about the architecture…"
          disabled={disabled || loading}
          className="flex-1 px-4 py-2.5 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 text-sm"
        />
        <button
          type="submit"
          disabled={disabled || loading || !question.trim()}
          className="px-5 py-2.5 rounded-lg bg-violet-600 text-white font-semibold hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-sm"
        >
          {loading ? "Thinking…" : "Ask"}
        </button>
        {response && (
          <button
            type="button"
            onClick={handleClear}
            className="px-4 py-2.5 rounded-lg border border-zinc-600 text-zinc-400 hover:text-zinc-100 hover:border-zinc-400 transition-colors text-sm"
          >
            Clear
          </button>
        )}
      </form>

      {error && (
        <div className="mt-3 px-4 py-2 rounded bg-red-900/40 border border-red-700 text-red-300 text-sm">
          {error}
        </div>
      )}

      {response && (
        <div className="mt-4 space-y-4">
          {/* Answer */}
          <div className="p-4 rounded-lg bg-zinc-800/60 border border-zinc-700">
            <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Answer</h4>
            <p className="text-zinc-200 text-base leading-relaxed">{response.answer}</p>
          </div>

          {/* Tool trace */}
          {response.toolCalls && response.toolCalls.length > 0 && (
            <div className="p-4 rounded-lg bg-zinc-800/30 border border-zinc-700/50">
              <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Agent Tool Trace</h4>
              <ul className="space-y-1">
                {response.toolCalls.map((tc, i) => (
                  <li key={i} className="font-mono text-xs text-zinc-400">
                    {tc.name}({JSON.stringify(tc.args)})
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Cited nodes */}
          {response.citedNodeIds && response.citedNodeIds.length > 0 && (
            <div className="text-xs text-zinc-500">
              <span className="font-semibold">Cited nodes:</span>{" "}
              {response.citedNodeIds.join(", ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
