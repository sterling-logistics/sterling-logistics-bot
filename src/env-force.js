import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
const result = dotenv.config({ path: envPath, override: true });
if (result.error) {
  console.warn(`[Config] Could not force-load ${envPath}: ${result.error.message}`);
} else {
  console.log(`[Config] .env overrides enabled from ${envPath}`);
}
