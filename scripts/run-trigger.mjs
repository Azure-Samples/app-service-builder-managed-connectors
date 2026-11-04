import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runtime } from "./config.mjs";

const cases = {
  "control-negative": { trigger: "auth-control", status: 403 },
  "control-wrong-audience": { trigger: "auth-control", status: 401 },
  "control-allowed": { trigger: "auth-control", status: 200, received: 0, flagged: 0 },
  "mail-trigger": { trigger: "mail-test", status: 200, received: 1, flagged: 1 },
};

export async function runTrigger({ c, kind, seconds = 120, request, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => performance.now(), signal, onEnabled = () => {} }) {
  const spec = cases[kind];
  if (!spec || !Number.isInteger(seconds) || seconds < 1 || seconds > 300) throw new Error("Use a known case and a 1-300 second window.");
  const body = runtime(c)[kind];
  const path = `${c.namespaceResourceId}/triggerConfigs/${spec.trigger}`;
  const get = (suffix, query) => request({ method: "get", path: path + suffix, query });
  if (await get("", "properties.state") !== "Disabled") throw new Error("Existing trigger must be Disabled; inspect before retrying.");
  const query = "value[].{id:id,status:status}";
  const previous = new Set((await get("/runs", query)).map(run => run.id));
  if (signal?.aborted) throw new Error("Cancelled before enable; no trigger write made.");
  const started = now();
  let outcome;
  try {
    body.properties.state = "Enabled";
    await request({ method: "put", path, body });
    if (await get("", "properties.state") !== "Enabled") throw new Error("Enable not confirmed; stopping this test.");
    onEnabled();
    while (now() - started < seconds * 1000 && !signal?.aborted) {
      const observed = (await get("/runs", query)).filter(run => !previous.has(run.id) && !["Running", "Waiting"].includes(run.status));
      if (observed.length) {
        if (observed.length !== 1) throw new Error("Unexpected multiple runs; inspect counts before retrying.");
        outcome = await get(`/runs/${observed[0].id}`,
          "{httpStatus:notification.outputs.statusCode,received:notification.outputs.body.received,flagged:notification.outputs.body.flagged}");
        break;
      }
      await sleep(5000);
    }
  } finally {
    body.properties.state = "Disabled";
    await request({ method: "put", path, body });
    if (await get("", "properties.state") !== "Disabled") throw new Error("Disable not confirmed: stop all test activity and inspect this trigger.");
  }
  if (!outcome) throw new Error("No completed run within the window; trigger disabled. Do not resend mail or replay an unknown write.");
  if (outcome.httpStatus !== spec.status ||
    (spec.received !== undefined && (outcome.received !== spec.received || outcome.flagged !== spec.flagged))) {
    throw new Error(`Unexpected callback result: ${JSON.stringify(outcome)}. Trigger disabled; no automatic retry.`);
  }
  return { kind, ...outcome, enabledSeconds: (now() - started) / 1000, finalState: "Disabled" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file, kind, seconds = "120"] = process.argv.slice(2);
  if (!file || !cases[kind]) throw new Error("Usage: node scripts/run-trigger.mjs CONTEXT_JSON control-negative|control-wrong-audience|control-allowed|mail-trigger [SECONDS]");
  const c = JSON.parse(await readFile(file, "utf8"));
  const execute = promisify(execFile);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const request = async ({ method, path, body, query }) => {
    const args = ["rest", "--subscription", c.subscriptionId, "--method", method, "--url", `https://management.azure.com${path}?api-version=2026-05-01-preview`, "-o", query ? "json" : "none"];
    if (query) args.push("--query", query);
    if (body) args.push("--body", JSON.stringify(body));
    const { stdout } = await execute("az", args, { timeout: 30000, maxBuffer: 1024 * 1024 });
    return query ? JSON.parse(stdout) : undefined;
  };
  const result = await runTrigger({
    c, kind, seconds: Number(seconds), request, signal: controller.signal,
    onEnabled: () => console.log(kind === "mail-trigger" ?
      "Enabled. Send exactly the two approved synthetic messages now; keep this process running." :
      "Enabled. Waiting for the first authentication-only callback."),
  });
  console.log(JSON.stringify(result));
}
