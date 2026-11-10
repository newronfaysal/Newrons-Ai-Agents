import path from "node:path";
import { loadConfig } from "./config.js";
import { backupDb, openAndMigrate } from "./db.js";

const cfg = loadConfig();
const db = openAndMigrate(path.join(cfg.dataDir, "ai-office.db"));
console.log("Backup written:", backupDb(db, cfg.dataDir));
