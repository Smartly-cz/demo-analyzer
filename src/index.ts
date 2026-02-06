import express from "express";
import path from "path";
import { getDb } from "./database";
import routes from "./routes";

// Load .env if present
try {
  const fs = require("fs");
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const key = trimmed.substring(0, eqIdx).trim();
          const value = trimmed.substring(eqIdx + 1).trim();
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
    }
  }
} catch {
  // .env loading is optional
}

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

// Middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, "..", "public")));

// API routes
app.use(routes);

// SPA fallback
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// Initialize DB and start
getDb();

app.listen(PORT, () => {
  console.log(`Demo Analyzer running at http://localhost:${PORT}`);
  console.log(`API docs: http://localhost:${PORT}/api`);
});

export default app;
