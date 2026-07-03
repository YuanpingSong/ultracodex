import { createHash, randomBytes } from "node:crypto";
import { RUN_ID_PREFIX } from "./constants.js";

export function newRunId(): string {
  const t = Date.now().toString(36);
  const r = randomBytes(3).readUIntBE(0, 3).toString(36).padStart(5, "0");
  return `${RUN_ID_PREFIX}${t}${r}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "agent"
  );
}
