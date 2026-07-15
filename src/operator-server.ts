import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RunLedger, RunListCursor } from "./ledger.js";
import {
  toOperatorOverview,
  toOperatorRunDetail,
  toOperatorRunSummary,
  type OperatorPolicySummary,
} from "./operator-view.js";

export interface OperatorConsoleConfig {
  token: string;
  ledger: Pick<
    RunLedger,
    "automationControl" | "getByRunKey" | "listRuns" | "operatorStats" | "setAutomationPaused"
  >;
  policy: OperatorPolicySummary;
}

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const dashboard = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MergeProof Operator Console</title><style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#07111e;color:#e8f0fb}body{margin:0;max-width:1180px;padding:32px;margin-inline:auto}header{display:flex;justify-content:space-between;align-items:baseline;gap:20px}h1{font-size:28px;margin:0}.muted{color:#9ab0ca}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0}.card,section{background:#0e1b2c;border:1px solid #233a55;border-radius:12px;padding:16px}.card strong{display:block;font-size:25px;margin-top:5px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid #233a55;vertical-align:top}button{font:inherit;border:1px solid #3a5f88;background:#102a45;color:#e8f0fb;padding:7px 10px;border-radius:7px;cursor:pointer}button:hover{background:#17436b}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.pill{display:inline-block;border-radius:99px;background:#173957;padding:3px 8px;font-size:12px}.warn{background:#633618}.bad{background:#6c2636}.ok{background:#174c3b}#detail{white-space:pre-wrap;overflow-wrap:anywhere}details{margin:12px 0}summary{cursor:pointer;font-weight:600}@media(max-width:700px){body{padding:18px}table{display:block;overflow:auto}}
</style></head><body><header><div><h1>MergeProof</h1><p class="muted">Evidence console with a durable emergency stop. GitHub remains the merge authority.</p></div><div><span id="mode" class="pill">Loading</span> <button id="pause" type="button">Pause automation</button> <button id="resume" type="button">Resume automation</button></div></header>
<div id="cards" class="grid"></div><section><h2>Recent exact-revision runs</h2><p id="summary" class="muted">Loading runs…</p><table><thead><tr><th>Repository / PR</th><th>Evidence</th><th>Lifecycle</th><th>Decision</th><th></th></tr></thead><tbody id="runs"></tbody></table></section><section id="detail"><h2>Run detail</h2><p class="muted">Choose a run to inspect only its sanitized deterministic evidence.</p></section>
<script>
const el=id=>document.getElementById(id);const text=(node,value)=>node.textContent=String(value??'—');
const card=(label,value,extra='')=>{const d=document.createElement('div');d.className='card';const l=document.createElement('span');l.className='muted';text(l,label);const v=document.createElement('strong');text(v,value);d.append(l,v);if(extra){const e=document.createElement('small');e.className='muted';text(e,extra);d.append(e)}return d};
const request=async path=>{const r=await fetch(path,{cache:'no-store'});if(!r.ok)throw new Error(r.status===401?'Operator authentication is required.':'Operator API unavailable ('+r.status+').');return r.json()};
const control=async action=>{const r=await fetch('/api/operator/v1/automation/'+action,{method:'POST',headers:{'x-mergeproof-operator-action':action},cache:'no-store'});if(!r.ok)throw new Error('Automation control unavailable ('+r.status+').');return r.json()};
const classFor=v=>v==='LOW_OBSERVED_RISK'||v==='QUEUED'||v==='reported'?'ok':v==='BLOCK'||v==='NOT_ELIGIBLE'||v==='merge_failed'?'bad':'warn';
function addCell(row,value,code=false){const c=document.createElement('td');if(code){const x=document.createElement('code');text(x,value);c.append(x)}else text(c,value);row.append(c)}
function renderDetail(run){const root=el('detail');root.replaceChildren();const title=document.createElement('h2');text(title,'Run detail');root.append(title);const meta=document.createElement('p');meta.className='muted';text(meta,'Run key '+run.runKey);root.append(meta);const d=document.createElement('p');const pill=document.createElement('span');pill.className='pill '+classFor(run.evidence?.verdict||run.status);text(pill,run.evidence?.verdict||run.status);d.append(pill,document.createTextNode(' '+(run.decision?.reason||'No decision snapshot is available yet.')));root.append(d);if(!run.evidence){return}const evidence=document.createElement('div');const line=(label,value)=>{const p=document.createElement('p');const b=document.createElement('strong');text(b,label+': ');p.append(b,document.createTextNode(value));evidence.append(p)};line('Policy',run.evidence.policyVersion);line('Receipt integrity',run.evidence.integrityHash);line('Revision',run.revision.baseSha+' → '+run.revision.headSha+' → '+run.revision.mergeSha);line('Agent review',run.evidence.agent.status+'; '+run.evidence.agent.hypothesisCount+' hypotheses, '+run.evidence.agent.challengeCount+' challenges (advisory only)');root.append(evidence);for(const [title,items,fields] of [['Evidence reasons',run.evidence.reasons,['code','subject','detail']],['Observed checks',run.evidence.checks,['id','kind','base','candidate']],['Infrastructure metrics',run.evidence.metrics,['name','base','candidate','threshold']]]){const details=document.createElement('details');details.open=true;const summary=document.createElement('summary');text(summary,title);details.append(summary);const table=document.createElement('table');const head=document.createElement('thead');const hr=document.createElement('tr');for(const f of fields){const h=document.createElement('th');text(h,f);hr.append(h)}head.append(hr);table.append(head);const body=document.createElement('tbody');for(const item of items){const row=document.createElement('tr');for(const f of fields)addCell(row,typeof item[f]==='object'?JSON.stringify(item[f]):item[f],f==='id'||f==='code');body.append(row)}table.append(body);details.append(table);root.append(details)}}
async function load(){try{const [overview,page]=await Promise.all([request('/api/operator/v1/overview'),request('/api/operator/v1/runs?limit=50')]);const paused=overview.automation.paused;el('mode').className='pill '+(!paused&&overview.policy.autoMergeEnabled?'ok':'warn');text(el('mode'),paused?'Automation paused':overview.policy.autoMergeEnabled?'Auto merge enabled':'Auto merge disabled');el('pause').disabled=paused;el('resume').disabled=!paused;const cards=el('cards');cards.replaceChildren(card('Webhook queue',overview.stats.inbox.queued+' queued',overview.stats.inbox.pendingBytes+' / '+overview.stats.inbox.maxPendingBytes+' retained bytes'),card('Active verifications',overview.stats.runs.running),card('Queued for GitHub',overview.stats.runs.queued),card('Needs reconciliation',overview.reconciliationRequired),card('Dead-letter retry',overview.stats.inbox.deadLetter),card('Failed deliveries',overview.stats.inbox.failed));text(el('summary'),page.runs.length+' latest run(s). Refreshes every 15 seconds.');const body=el('runs');body.replaceChildren();for(const run of page.runs){const row=document.createElement('tr');addCell(row,run.revision?run.revision.repository+' #'+run.revision.pullRequest:'Receipt not yet recorded');addCell(row,run.evidence?.verdict||'pending');addCell(row,run.status);addCell(row,run.decision?.reason||run.outcome||'pending');const action=document.createElement('td');const b=document.createElement('button');text(b,'Inspect');b.onclick=async()=>{try{renderDetail(await request('/api/operator/v1/runs/'+run.runKey))}catch(e){text(el('detail'),e.message)}};action.append(b);row.append(action);body.append(row)}}catch(error){text(el('summary'),error instanceof Error?error.message:'Operator console unavailable')}}el('pause').onclick=async()=>{try{await control('pause');await load()}catch(error){text(el('summary'),error instanceof Error?error.message:'Automation pause failed')}};el('resume').onclick=async()=>{try{await control('resume');await load()}catch(error){text(el('summary'),error instanceof Error?error.message:'Automation resume failed')}};load();setInterval(load,15000);
</script></body></html>`;

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const expected = `Basic ${Buffer.from(`operator:${token}`, "utf8").toString("base64")}`;
  const received = header(request, "authorization");
  if (!received || received.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(received, "utf8"), Buffer.from(expected, "utf8"));
}

function reply(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...securityHeaders });
  response.end(JSON.stringify(body));
}

function decodeCursor(value: string | null): RunListCursor | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<RunListCursor>;
    if (
      typeof parsed.updatedAt !== "number" ||
      !Number.isSafeInteger(parsed.updatedAt) ||
      typeof parsed.runKey !== "string" ||
      !/^[a-f0-9]{64}$/i.test(parsed.runKey)
    ) {
      return undefined;
    }
    return { updatedAt: parsed.updatedAt, runKey: parsed.runKey };
  } catch {
    return undefined;
  }
}

function encodeCursor(cursor: RunListCursor | undefined): string | undefined {
  return cursor ? Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url") : undefined;
}

/** Returns true when the request belonged to the optional, read-only console. */
export function serveOperatorConsole(
  request: IncomingMessage,
  response: ServerResponse,
  config: OperatorConsoleConfig,
): boolean {
  const url = new URL(request.url ?? "/", "http://mergeproof.local");
  const operatorPath = url.pathname === "/ops" || url.pathname.startsWith("/api/operator/v1/");
  if (!operatorPath) {
    return false;
  }
  const automationAction = url.pathname.match(/^\/api\/operator\/v1\/automation\/(pause|resume)$/)?.[1];
  if (request.method === "POST" && automationAction) {
    if (header(request, "x-mergeproof-operator-action") !== automationAction) {
      reply(response, 400, { error: "operator_action_confirmation_required" });
      return true;
    }
    const automation = config.ledger.setAutomationPaused(automationAction === "pause");
    reply(response, 200, { automation });
    return true;
  }
  if (request.method !== "GET") {
    reply(response, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!isAuthorized(request, config.token)) {
    response.writeHead(401, {
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": 'Basic realm="MergeProof Operator", charset="UTF-8"',
      ...securityHeaders,
    });
    response.end(JSON.stringify({ error: "operator_authentication_required" }));
    return true;
  }
  if (url.pathname === "/ops") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...securityHeaders });
    response.end(dashboard);
    return true;
  }
  if (url.pathname === "/api/operator/v1/overview") {
    reply(
      response,
      200,
      toOperatorOverview(config.policy, config.ledger.operatorStats(), config.ledger.automationControl()),
    );
    return true;
  }
  if (url.pathname === "/api/operator/v1/runs") {
    const suppliedLimit = url.searchParams.get("limit");
    const limit = suppliedLimit === null ? 50 : Number(suppliedLimit);
    const cursor = decodeCursor(url.searchParams.get("cursor"));
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (url.searchParams.has("cursor") && !cursor)) {
      reply(response, 400, { error: "invalid_pagination" });
      return true;
    }
    const page = config.ledger.listRuns({ limit, ...(cursor ? { cursor } : {}) });
    reply(response, 200, {
      runs: page.runs.map(toOperatorRunSummary),
      ...(encodeCursor(page.nextCursor) ? { nextCursor: encodeCursor(page.nextCursor) } : {}),
    });
    return true;
  }
  const runKey = url.pathname.match(/^\/api\/operator\/v1\/runs\/([a-f0-9]{64})$/i)?.[1];
  if (runKey) {
    const run = config.ledger.getByRunKey(runKey);
    if (!run) {
      reply(response, 404, { error: "run_not_found" });
      return true;
    }
    reply(response, 200, toOperatorRunDetail(run));
    return true;
  }
  reply(response, 404, { error: "not_found" });
  return true;
}
