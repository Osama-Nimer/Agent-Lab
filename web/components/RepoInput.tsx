"use client";

import { useState } from "react";

interface Props {
  onAnalyze: (input: { repoUrl?: string; localPath?: string }) => void;
  onLoadSample: () => void;
  loading: boolean;
  repoName: string | null;
}

export default function RepoInput({ onAnalyze, onLoadSample, loading, repoName }: Props) {
  const [value, setValue] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    const input = value.startsWith("http") ? { repoUrl: value.trim() } : { localPath: value.trim() };
    onAnalyze(input);
  };

  return (
    <div className="flex flex-col items-center gap-4 w-full max-w-2xl mx-auto">
      <form onSubmit={handleSubmit} className="flex w-full gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Repo URL or local path…"
          disabled={loading}
          className="flex-1 px-4 py-3 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
        />
        <button
          type="submit"
          disabled={loading || !value.trim()}
          className="px-6 py-3 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-base"
        >
          Analyze
        </button>
      </form>
      <button
        onClick={onLoadSample}
        disabled={loading}
        className="px-4 py-2 rounded border border-zinc-600 text-zinc-400 hover:text-zinc-100 hover:border-zinc-400 transition-colors text-sm disabled:opacity-40"
      >
        Load sample fixture
      </button>
      {loading && repoName && (
        <div className="flex items-center gap-3 text-zinc-400 text-sm mt-2">
          <svg className="animate-spin h-5 w-5 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Analyzing <span className="text-zinc-200 font-medium">{repoName}</span>…
        </div>
      )}
    </div>
  );
}
