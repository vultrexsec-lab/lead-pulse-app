"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import Dashboard from "@/components/Dashboard";
import Login from "@/components/Login";
import { API_BASE } from "@/lib/utils";
import { clearToken, getToken } from "@/lib/auth";

export default function Home() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    let active = true;
    async function check() {
      const token = getToken();
      if (!token) {
        if (active) {
          setAuthed(false);
          setReady(true);
        }
        return;
      }
      try {
        await axios.get(`${API_BASE}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 15000,
        });
        if (active) setAuthed(true);
      } catch {
        clearToken();
        if (active) setAuthed(false);
      } finally {
        if (active) setReady(true);
      }
    }
    check();
    return () => {
      active = false;
    };
  }, []);

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center text-slate-400">
        Loading...
      </main>
    );
  }

  if (!authed) {
    return <Login onSuccess={() => setAuthed(true)} />;
  }

  return <Dashboard onLogout={() => { clearToken(); setAuthed(false); }} />;
}
