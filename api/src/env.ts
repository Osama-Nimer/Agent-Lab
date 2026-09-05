// Loads api/.env if present (Node >= 20.12 built-in, no dotenv dependency). Never throws.
import { fileURLToPath } from "node:url";
import path from "node:path";

const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
try {
  process.loadEnvFile(envPath);
} catch {
  // no .env — rely on the process environment
}

export const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(API_ROOT, "..");
export const FIXTURES_DIR = path.join(REPO_ROOT, "fixtures");
