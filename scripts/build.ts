import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ncc = path.resolve("node_modules/@vercel/ncc/dist/ncc/cli.js");
const out = mkdtempSync(path.join(os.tmpdir(), "aireg-publish-build-"));
try {
  const built = spawnSync(process.execPath, [ncc, "build", "src/main.ts", "-o", out, "--license", "licenses.txt", "--target", "es2023", "--quiet"], { stdio: "inherit" });
  if (built.status !== 0) throw new Error("ncc could not build src/main.ts");
  const bundle = readFileSync(path.join(out, "index.js"), "utf8").replace(/[\t ]+$/gm, "");
  const licenseFile = path.join(out, "licenses.txt");
  // ncc writes no license file for a bundle without dependencies.
  const licenses = existsSync(licenseFile) ? readFileSync(licenseFile, "utf8").trim() : "";
  // Replace dist/ only after a successful build, so a failed one never leaves it half written or empty.
  rmSync("dist", { recursive: true, force: true });
  mkdirSync("dist");
  writeFileSync("dist/index.mjs", bundle);
  if (licenses) writeFileSync("dist/licenses.txt", `${licenses}\n`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
