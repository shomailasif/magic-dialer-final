"use client";

import { useState, useEffect, useCallback } from "react";

interface Customer {
  userId: string;
  product: string;
  persona: string;
  contactEmail: string;
  status: string;
  lastSeen: number | null;
  voipReady: boolean;
  voipShared: boolean;
  voip: any;
  callList: string[];
  leadsFound: any[];
  disabled: boolean;
  machineId: string;
  companyName: string;
  createdBy: string;
}

export default function AdminPortal() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);
  const [adminEmail, setAdminEmail] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchCustomers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/admin/portal/customers");
      if (r.status === 401) { setLoggedIn(false); setLoading(false); return; }
      const data = await r.json();
      setCustomers(data.customers || []);
    } catch { setError("Failed to load customers"); }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetch("/api/admin/portal/customers").then(async r => {
      if (r.ok) {
        setLoggedIn(true);
        const data = await r.json();
        setCustomers(data.customers || []);
      }
    }).catch(() => {});
  }, []);

  const initDatabase = async () => {
    setError("");
    try {
      const r = await fetch("/api/admin/portal/init", { method: "POST" });
      const data = await r.json();
      if (r.ok) setError("");
      else setError(data.error || "Init failed");
    } catch { setError("Init failed"); }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    await initDatabase();
    const r = await fetch("/api/admin/portal/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    });
    const data = await r.json();
    if (r.ok) { setLoggedIn(true); setAdminEmail(data.email || email); fetchCustomers(); }
    else setError(data.error || "Wrong email or password");
  };

  const handleLogout = async () => {
    await fetch("/api/admin/portal/login", { method: "DELETE" });
    setLoggedIn(false);
    setCustomers([]);
    setAdminEmail("");
    setEmail("");
    setPassword("");
  };

  const toggleShared = async (userId: string) => {
    setError("");
    try {
      const r = await fetch("/api/admin/portal/toggle-voip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, voipShared: true }),
      });
      if (!r.ok) { const d = await r.json(); setError(d.error || "Toggle failed"); return; }
      fetchCustomers();
    } catch { setError("Toggle failed"); }
  };

  const setVoipConfig = async (userId: string) => {
    const provider = prompt("VOIP provider (ringcentral, twilio, etc.):", "ringcentral");
    if (!provider?.trim()) return;
    const number = prompt("Outgoing caller ID / number:", "");
    if (!number?.trim()) return;
    const username = prompt("SIP username:", "");
    if (!username?.trim()) return;
    const sipPassword = prompt("SIP password:", "");
    if (sipPassword == null) return;
    const server = prompt("SIP server (e.g. sip40.ringcentral.com):", "sip40.ringcentral.com");
    if (!server?.trim()) return;
    const port = prompt("Port:", "5096");
    if (port == null) return;
    const voip = { provider: provider.trim(), number: number.trim(), username: username.trim(), sipPassword, authId: username.trim(), server: server.trim(), port: port.trim(), ready: true };
    setError("");
    try {
      const r = await fetch("/api/admin/portal/toggle-voip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, voip }),
      });
      if (!r.ok) { const d = await r.json(); setError(d.error || "VOIP config failed"); return; }
      fetchCustomers();
    } catch { setError("VOIP config failed"); }
  };

  if (!loggedIn) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0e1a" }}>
        <div style={{ background: "#111827", padding: 40, borderRadius: 16, width: 400, border: "1px solid rgba(99,102,241,.2)" }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#e2e8f0", marginBottom: 4 }}>Magic Dialer</h1>
          <p style={{ color: "#7c8aa8", fontSize: 13, marginBottom: 24 }}>Admin Console</p>
          <form onSubmit={handleLogin}>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" autoFocus style={{ width: "100%", padding: "10px 14px", borderRadius: 8, border: "1px solid rgba(99,102,241,.3)", background: "#0d1226", color: "#e2e8f0", fontSize: 14, marginBottom: 12, boxSizing: "border-box" }} />
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" style={{ width: "100%", padding: "10px 14px", borderRadius: 8, border: "1px solid rgba(99,102,241,.3)", background: "#0d1226", color: "#e2e8f0", fontSize: 14, marginBottom: 16, boxSizing: "border-box" }} />
            <button type="submit" style={{ width: "100%", padding: 12, borderRadius: 8, border: "none", background: "linear-gradient(135deg,#6366f1,#38bdf8)", color: "white", fontWeight: 600, fontSize: 14, cursor: "pointer" }}>Sign in</button>
          </form>
          {error && <p style={{ color: "#f87171", fontSize: 13, marginTop: 12, textAlign: "center" }}>{error}</p>}
          <button onClick={initDatabase} style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid rgba(248,113,113,.3)", background: "transparent", color: "#f87171", cursor: "pointer", fontSize: 12, marginTop: 16 }}>Initialize Database (first time only)</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#0a0e1a", color: "#e2e8f0", padding: 24 }}>
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, background: "linear-gradient(90deg,#a5b4fc,#38bdf8)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Magic Dialer</h1>
            <p style={{ color: "#7c8aa8", fontSize: 12 }}>Admin Console · {adminEmail}</p>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <span style={{ color: "#7c8aa8", fontSize: 12 }}>{customers.length} customers</span>
            <button onClick={() => fetchCustomers()} style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid rgba(99,102,241,.3)", background: "transparent", color: "#a5b4fc", cursor: "pointer", fontSize: 12 }}>Refresh</button>
            <button onClick={handleLogout} style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid rgba(248,113,113,.3)", background: "transparent", color: "#f87171", cursor: "pointer", fontSize: 12 }}>Sign out</button>
          </div>
        </div>

        {error && <div style={{ background: "#7f1d1d30", border: "1px solid #7f1d1d", borderRadius: 8, padding: 12, marginBottom: 16, color: "#fca5a5", fontSize: 13 }}>{error}</div>}
        {loading && <p style={{ color: "#7c8aa8" }}>Loading...</p>}

        <div style={{ display: "grid", gap: 12 }}>
          {customers.map((c, idx) => {
            const state = c.disabled ? "DISABLED" : c.status === "online" ? "ONLINE" : "OFFLINE";
            const stateColor = c.disabled ? "#f87171" : c.status === "online" ? "#34d399" : "#6b7a99";
            const lastSeen = c.lastSeen ? new Date(c.lastSeen).toLocaleString() : "never";
            return (
              <div key={c.userId || idx} style={{ background: "#111827", borderRadius: 12, padding: 20, border: "1px solid rgba(99,102,241,.1)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{c.product}</div>
                    <div style={{ color: "#7c8aa8", fontSize: 12, marginTop: 2 }}>{c.companyName || "-"}{c.persona ? " · " + c.persona : ""}</div>
                    <div style={{ color: "#7c8aa8", fontSize: 12, marginTop: 4 }}>{c.contactEmail || "-"}</div>
                    <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>Last seen: {lastSeen}</div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 20, fontWeight: 600, background: stateColor + "15", color: stateColor, border: "1px solid " + stateColor + "30" }}>{state}</span>
                    <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 20, fontWeight: 600, background: c.voipReady ? "#34d39915" : "#6b7a9915", color: c.voipReady ? "#34d399" : "#6b7a99", border: "1px solid " + (c.voipReady ? "#34d39930" : "#6b7a9930") }}>{c.voipShared ? "SHARED" : c.voipReady ? "VOIP ON" : "no line"}</span>
                    <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 20, background: "#64748b15", color: "#94a3b8" }}>{(c.callList ?? []).length} numbers</span>
                    <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 20, background: "#64748b15", color: "#94a3b8" }}>{(c.leadsFound ?? []).length} leads</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                  <button onClick={() => toggleShared(c.userId)} style={{ padding: "5px 14px", borderRadius: 6, border: "1px solid " + (c.voipShared ? "#f59e0b40" : "rgba(99,102,241,.3)"), background: c.voipShared ? "#f59e0b15" : "transparent", color: c.voipShared ? "#f59e0b" : "#a5b4fc", cursor: "pointer", fontSize: 12, fontWeight: 500 }}>{c.voipShared ? "Unshare RC" : "Share RC"}</button>
                  <button onClick={() => setVoipConfig(c.userId)} style={{ padding: "5px 14px", borderRadius: 6, border: "1px solid rgba(99,102,241,.3)", background: "transparent", color: "#a5b4fc", cursor: "pointer", fontSize: 12 }}>VOIP Config</button>
                </div>
              </div>
            );
          })}
          {!loading && customers.length === 0 && <p style={{ color: "#7c8aa8", textAlign: "center", padding: 40 }}>No customers yet. Customers appear here after they sign up and link their agent.</p>}
        </div>
      </div>
    </div>
  );
}
