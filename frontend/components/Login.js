"use client";

import { useState } from "react";
import axios from "axios";
import { Loader2, Lock, MessageCircle } from "lucide-react";
import { API_BASE } from "@/lib/utils";
import { setToken } from "@/lib/auth";

export default function Login({ onSuccess }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { data } = await axios.post(
        `${API_BASE}/api/auth/login`,
        { username: username.trim(), password },
        { timeout: 30000 }
      );
      if (!data?.success || !data?.token) {
        throw new Error(data?.message || "Login failed");
      }
      setToken(data.token);
      onSuccess?.(data);
    } catch (err) {
      const message =
        err.response?.data?.message ||
        err.message ||
        "Login failed";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="rounded-3xl border border-white/10 bg-[#0d141c] p-6 sm:p-8">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#25D366] text-[#06210f]">
            <MessageCircle className="h-7 w-7" fill="currentColor" />
          </span>
          <div>
            <h1 className="text-xl font-semibold">Lead Pulse</h1>
            <p className="text-sm text-slate-400">Sign in to continue</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-sm text-slate-400">Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 outline-none ring-[#25D366] focus:ring-2"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm text-slate-400">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 outline-none ring-[#25D366] focus:ring-2"
            />
          </label>

          {error && <p className="text-sm text-rose-300">{error}</p>}

          <button
            type="submit"
            disabled={loading || !username || !password}
            className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#25D366] px-5 py-3 font-semibold text-[#06210f] transition hover:bg-[#1ebe5d] disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-slate-500"
          >
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Lock className="h-5 w-5" />}
            Login
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-slate-500">
          Access is restricted. No self-registration.
        </p>
      </div>
    </main>
  );
}
