import { useState } from "react";
import { ArrowLeft, Eye, EyeOff } from "lucide-react";

export default function Signup({ onBack, onLoginSuccess }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    setError("");
    if (!email || !email.includes("@")) { setError("Please enter a valid email address."); return; }
    if (password.length < 6) { setError("Password must be at least 6 characters."); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/user/signup-free", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Signup failed. Please try again."); setLoading(false); return; }
      onLoginSuccess(data.token, data.user);
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  };

  return (
    <div className="signup-page">
      <div className="signup-page__topbar">
        <button type="button" className="signup-back-btn" onClick={onBack}>
          <ArrowLeft size={15} /> Back
        </button>
        <div className="signup-brand">
          <span style={{color:"#2dd4bf"}}>P</span><span style={{color:"#38bdf8"}}>R</span><span style={{color:"#818cf8"}}>I</span><span style={{color:"#a78bfa"}}>S</span><span style={{color:"#c084fc"}}>M</span>
        </div>
      </div>

      <div style={{display:"flex",alignItems:"center",justifyContent:"center",flex:1,padding:"40px 20px",minHeight:"calc(100vh - 64px)"}}>
        <div style={{width:"100%",maxWidth:420}}>
          <h1 style={{fontSize:26,fontWeight:800,margin:"0 0 6px",color:"var(--text)"}}>Create your account</h1>
          <p style={{fontSize:14,color:"var(--muted)",margin:"0 0 28px"}}>Enter your details — you'll choose a plan after signing in.</p>

          <div className="signup-fields">
            <label className="field">
              <span>Work email</span>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="you@company.com" autoFocus autoComplete="email"
                onKeyDown={e => e.key === "Enter" && handleSubmit()} />
            </label>

            <label className="field">
              <span>Password</span>
              <div className="signup-pass-wrap">
                <input type={showPass ? "text" : "password"} value={password}
                  onChange={e => setPassword(e.target.value)} placeholder="Minimum 6 characters"
                  autoComplete="new-password"
                  onKeyDown={e => e.key === "Enter" && handleSubmit()} />
                <button type="button" className="signup-pass-toggle" onClick={() => setShowPass(v => !v)}>
                  {showPass ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </label>
          </div>

          {error && <div className="signup-error">{error}</div>}

          <button type="button" className="btn primary signup-cta"
            onClick={handleSubmit} disabled={loading} style={{width:"100%",marginTop:20}}>
            {loading ? "Creating account..." : "Create Account"}
          </button>

          <p className="signup-legal" style={{marginTop:16}}>
            By creating an account you agree to our{" "}
            <a href="/terms" target="_blank" rel="noreferrer">Terms of Service</a> and{" "}
            <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.
          </p>

          <div className="signup-login-link">
            Already have an account?{" "}
            <button type="button" onClick={onBack}>Login here</button>
          </div>
        </div>
      </div>
    </div>
  );
}
