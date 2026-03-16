/**
 * Live test: connect to the P1S, send a print_3mf command, then immediately cancel.
 * Requires .env with real printer credentials.
 *
 * Usage: node tests/live-print-cancel.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "index.js");

// Load .env manually
const envPath = path.join(REPO_ROOT, ".env");
const envLines = readFileSync(envPath, "utf8").split("\n");
const envVars = { ...process.env };
for (const line of envLines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIndex = trimmed.indexOf("=");
  if (eqIndex === -1) continue;
  envVars[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
}

// Force stdio transport, wipe BAMBU_MODEL so elicitation fires
envVars.MCP_TRANSPORT = "stdio";
delete envVars.BAMBU_MODEL;

const THREE_MF_PATH = path.resolve(
  process.env.HOME,
  "Downloads/Wall-Shelf-Clips-Only-Sliced.3mf"
);

console.log("=== Live Print-Cancel Test ===");
console.log(`Server: ${SERVER_ENTRY}`);
console.log(`3MF: ${THREE_MF_PATH}`);
console.log(`Printer: ${envVars.PRINTER_HOST} (${envVars.BAMBU_MODEL})`);
console.log();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER_ENTRY],
  env: envVars,
  stderr: "pipe",
});

let stderrOutput = "";
transport.stderr?.on?.("data", (chunk) => {
  const text = chunk.toString();
  stderrOutput += text;
  process.stderr.write(text);
});

const client = new Client({
  name: "live-print-cancel-test",
  version: "0.0.1",
});

try {
  console.log("[1/5] Connecting to MCP server...");
  await client.connect(transport);
  console.log("  Connected:", client.getServerVersion()?.name);

  console.log("[2/5] Getting printer status...");
  const status = await client.callTool({
    name: "get_printer_status",
    arguments: {},
  });
  const statusText = status.content?.[0]?.text || "";
  const statusData = JSON.parse(statusText);
  console.log("  Printer status:", statusData.status);
  console.log("  Connected:", statusData.connected);

  if (!statusData.connected) {
    console.error("ERROR: Printer not connected. Aborting.");
    process.exit(1);
  }

  console.log("[3/5] Sending print_3mf command (bambu_model=p1s)...");
  const printResult = await client.callTool({
    name: "print_3mf",
    arguments: {
      three_mf_path: THREE_MF_PATH,
      bambu_model: "p1s",
      bed_type: "textured_plate",
    },
  });

  const printText = printResult.content?.[0]?.text || "";
  console.log("  print_3mf result:", printText);

  if (printResult.isError) {
    console.error("ERROR: print_3mf failed:", printText);
    process.exit(1);
  }

  // Brief pause so the printer acknowledges the command
  console.log("[4/5] Waiting 2 seconds then cancelling...");
  await sleep(2000);

  console.log("[5/5] Sending cancel_print...");
  const cancelResult = await client.callTool({
    name: "cancel_print",
    arguments: {},
  });
  const cancelText = cancelResult.content?.[0]?.text || "";
  console.log("  cancel_print result:", cancelText);

  console.log();
  console.log("=== Test Complete ===");
  console.log("The print command was sent and then cancelled.");
  console.log("Check the printer to confirm it stopped cleanly.");
} catch (error) {
  console.error("Test failed:", error.message);
  if (stderrOutput) {
    console.error("Server stderr:", stderrOutput.slice(-500));
  }
  process.exit(1);
} finally {
  try { await transport.close(); } catch {}
}
