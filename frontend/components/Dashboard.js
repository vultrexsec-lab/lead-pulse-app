"use client";

import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import {
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Filter,
  Globe,
  Loader2,
  MessageCircle,
  Search,
  Upload,
  XCircle,
} from "lucide-react";
import { API_BASE, COUNTRIES, cn } from "@/lib/utils";

const TABS = [
  { id: "file", label: "Excel File Filter", icon: FileSpreadsheet },
  { id: "url", label: "Website URL Scraper", icon: Globe },
  { id: "keyword", label: "Search Leads", icon: Search },
];

const EMPTY_STATS = {
  scraped: 0,
  valid: 0,
  invalid: 0,
  duplicates: 0,
};

function statusView(status) {
  if (status === "CONNECTED") {
    return { label: "Connected", dot: "bg-emerald-400", tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" };
  }
  if (status === "NEED_QR") {
    return { label: "Scan QR", dot: "bg-amber-300", tone: "border-amber-400/40 bg-amber-400/10 text-amber-200" };
  }
  return { label: "Disconnected", dot: "bg-rose-400", tone: "border-rose-500/40 bg-rose-500/10 text-rose-200" };
}

export default function Dashboard() {
  const [tab, setTab] = useState("file");
  const [connection, setConnection] = useState("DISCONNECTED");
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [url, setUrl] = useState("");
  const [keyword, setKeyword] = useState("");
  const [country, setCountry] = useState("India");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ percent: 0, message: "Ready to extract leads." });
  const [stats, setStats] = useState(EMPTY_STATS);
  const [leads, setLeads] = useState([]);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    async function loadStatus() {
      try {
        const { data } = await axios.get(`${API_BASE}/api/whatsapp/status`);
        if (active) setConnection(data.status || "DISCONNECTED");
      } catch {
        if (active) setConnection("DISCONNECTED");
      }
    }

    loadStatus();
    const timer = setInterval(loadStatus, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const badge = statusView(connection);
  const canStart = useMemo(() => {
    if (running) return false;
    if (tab === "file") return Boolean(file);
    if (tab === "url") return url.trim().length > 0;
    return keyword.trim().length > 0 && country.trim().length > 0;
  }, [running, tab, file, url, keyword, country]);

  function takeFile(nextFile) {
    if (!nextFile) return;
    const allowed = /\.(xlsx|xls|csv)$/i.test(nextFile.name);
    if (!allowed) {
      setError("Upload an .xlsx, .xls, or .csv file.");
      return;
    }
    setError("");
    setFile(nextFile);
  }

  async function startExtraction() {
    const processId = crypto.randomUUID();
    setRunning(true);
    setError("");
    setDownloadUrl("");
    setLeads([]);
    setStats(EMPTY_STATS);
    setProgress({ percent: 2, message: "Starting extraction..." });

    const poll = setInterval(async () => {
      try {
        const { data } = await axios.get(`${API_BASE}/api/process/progress/${processId}`);
        if (data?.message) setProgress(data);
      } catch {
        // The process request still owns the final result.
      }
    }, 400);

    try {
      const headers = { "x-process-id": processId };
      let response;

      if (tab === "file") {
        const form = new FormData();
        form.append("file", file);
        response = await axios.post(`${API_BASE}/api/process/file`, form, {
          headers,
          timeout: 0,
        });
      } else if (tab === "url") {
        response = await axios.post(
          `${API_BASE}/api/process/url`,
          { url: url.trim() },
          { headers, timeout: 0 }
        );
      } else {
        response = await axios.post(
          `${API_BASE}/api/process/keyword`,
          { keyword: keyword.trim(), country },
          { headers, timeout: 0 }
        );
      }

      const data = response.data;
      const total = data.total || 0;
      const valid = data.whatsappCount || 0;
      const duplicates = data.duplicatesRemoved || 0;
      setStats({
        scraped: total + duplicates,
        valid,
        invalid: Math.max(total - valid, 0),
        duplicates,
      });
      setLeads(data.leads || []);
      setDownloadUrl(data.downloadUrl || "");
      setProgress({ percent: 100, message: "Verification complete" });
    } catch (requestError) {
      const message = requestError.response?.data?.message || requestError.message || "Extraction failed";
      setError(message);
      setProgress({ percent: 100, message });
    } finally {
      clearInterval(poll);
      setRunning(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-4 rounded-3xl border border-white/10 bg-[#0d141c] px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#25D366] text-[#06210f] shadow-[0_0_32px_rgba(37,211,102,0.35)]">
            <MessageCircle className="h-7 w-7" fill="currentColor" />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Lead Pulse - WhatsApp Extractor</h1>
            <p className="text-sm text-slate-400">Find public leads, skip numbers you already scanned, and keep the WhatsApp matches.</p>
          </div>
        </div>
        <div className={cn("inline-flex items-center gap-2 self-start rounded-full border px-3 py-1.5 text-sm font-medium", badge.tone)}>
          <span className={cn("h-2.5 w-2.5 rounded-full", badge.dot)} />
          {badge.label}
        </div>
      </header>

      <section className="rounded-3xl border border-white/10 bg-[#0d141c] p-4 sm:p-5">
        <div className="grid gap-2 sm:grid-cols-3">
          {TABS.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                disabled={running}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-2xl border px-3 py-3 text-sm font-medium transition",
                  active
                    ? "border-[#25D366]/50 bg-[#25D366]/15 text-[#b6f5cd]"
                    : "border-white/10 bg-white/[0.03] text-slate-300 hover:border-white/20"
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </div>

        <div className="mt-5">
          {tab === "file" && (
            <label
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                takeFile(event.dataTransfer.files?.[0]);
              }}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-12 text-center",
                dragging ? "border-[#25D366] bg-[#25D366]/10" : "border-white/15 bg-black/20"
              )}
            >
              <Upload className="mb-3 h-8 w-8 text-[#25D366]" />
              <span className="font-medium">{file ? file.name : "Drop an Excel or CSV file here"}</span>
              <span className="mt-1 text-sm text-slate-400">.xlsx, .xls, or .csv</span>
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(event) => takeFile(event.target.files?.[0])}
              />
            </label>
          )}

          {tab === "url" && (
            <label className="block">
              <span className="mb-2 block text-sm text-slate-400">Website URL</span>
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com"
                className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 outline-none ring-[#25D366] placeholder:text-slate-500 focus:ring-2"
              />
            </label>
          )}

          {tab === "keyword" && (
            <div className="grid gap-3 sm:grid-cols-[1fr_220px]">
              <label className="block">
                <span className="mb-2 block text-sm text-slate-400">Keyword</span>
                <input
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder="dentist clinic"
                  className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 outline-none ring-[#25D366] placeholder:text-slate-500 focus:ring-2"
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm text-slate-400">Country</span>
                <select
                  value={country}
                  onChange={(event) => setCountry(event.target.value)}
                  className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 outline-none ring-[#25D366] focus:ring-2"
                >
                  {COUNTRIES.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={startExtraction}
          disabled={!canStart}
          className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#25D366] px-5 py-3 font-semibold text-[#06210f] transition hover:bg-[#1ebe5d] disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-slate-500"
        >
          {running ? <Loader2 className="h-5 w-5 animate-spin" /> : <Search className="h-5 w-5" />}
          Start Extraction & WhatsApp Verification
        </button>

        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between text-sm text-slate-300">
            <span>{progress.message}</span>
            <span>{Math.max(0, Math.min(100, progress.percent || 0))}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-[#25D366] transition-all"
              style={{ width: `${Math.max(0, Math.min(100, progress.percent || 0))}%` }}
            />
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Scraped" value={stats.scraped} icon={Globe} />
        <StatCard label="Valid WhatsApp (Active)" value={stats.valid} icon={CheckCircle2} tone="text-[#25D366]" />
        <StatCard label="Invalid / Non-WA" value={stats.invalid} icon={XCircle} tone="text-rose-300" />
        <StatCard label="Duplicates Removed (Filtered Out)" value={stats.duplicates} icon={Filter} tone="text-amber-200" />
      </section>

      <section className="rounded-3xl border border-white/10 bg-[#0d141c] p-4 sm:p-5">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-semibold">Results preview</h2>
          {downloadUrl ? (
            <a
              href={`${API_BASE}${downloadUrl}`}
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[#25D366] px-4 py-2.5 text-sm font-semibold text-[#06210f]"
            >
              <Download className="h-4 w-4" />
              Download Verified Excel Sheet (.xlsx)
            </a>
          ) : (
            <button
              type="button"
              disabled
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-white/10 px-4 py-2.5 text-sm font-semibold text-slate-500"
            >
              <Download className="h-4 w-4" />
              Download Verified Excel Sheet (.xlsx)
            </button>
          )}
        </div>
        <div className="overflow-auto rounded-2xl border border-white/10">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-white/[0.04] text-slate-400">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Phone Number</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">WhatsApp Status</th>
              </tr>
            </thead>
            <tbody>
              {leads.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                    Verified leads will appear here.
                  </td>
                </tr>
              ) : (
                leads.map((lead) => (
                  <tr key={`${lead.number}-${lead.source}`} className="border-t border-white/10">
                    <td className="px-4 py-3">{lead.name || "—"}</td>
                    <td className="px-4 py-3 font-mono">{lead.number}</td>
                    <td className="max-w-[240px] truncate px-4 py-3 text-slate-300">{lead.source || "—"}</td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "rounded-full px-2.5 py-1 text-xs font-semibold",
                          lead.isWhatsApp ? "bg-[#25D366]/15 text-[#b6f5cd]" : "bg-rose-500/10 text-rose-200"
                        )}
                      >
                        {lead.isWhatsApp ? "Active" : "Not on WhatsApp"}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function StatCard({ label, value, icon: Icon, tone = "text-slate-100" }) {
  return (
    <article className="rounded-3xl border border-white/10 bg-[#0d141c] p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-slate-400">{label}</p>
        <Icon className={cn("h-5 w-5", tone)} />
      </div>
      <p className={cn("text-3xl font-semibold", tone)}>{value}</p>
    </article>
  );
}
