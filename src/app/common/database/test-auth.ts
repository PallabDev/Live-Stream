async function test() {
  try {
    console.log("[Test-Auth] Hitting internal auth endpoint...");
    const res = await fetch("http://127.0.0.1:5678/api/stream/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ip: "1.39.120.253",
        action: "connect",
        path: "live_5597c049217642a9"
      })
    });
    console.log("[Test-Auth] Response Status:", res.status);
  } catch (err: any) {
    console.error("[Test-Auth] Connection failed:", err.message);
  }
}

test().then(() => process.exit(0));
