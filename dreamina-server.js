#!/usr/bin/env node
/**
 * Dreamina Batch Server — bridges the browser UI to the local dreamina CLI.
 *
 * Usage:  node dreamina-server.js [port]
 * Default port: 8765
 *
 * The server:
 * - Serves 即梦批量视频生成工具_v1.html
 * - Manages dreamina OAuth Device Flow login (headless capture + checklogin polling)
 * - Runs batch multimodal2video tasks sequentially
 * - Streams progress to the browser via SSE
 *
 * Dependencies: Node.js built-ins only (no npm install).
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawn, execFile } = require('child_process');

// ── Configuration ──────────────────────────────────────────────
const PORT       = parseInt(process.argv[2], 10) || 8765;
const SCRIPT_DIR = __dirname;
const HTML_FILE  = path.join(SCRIPT_DIR, '即梦批量视频生成工具_v1.html');

// ── Global state ───────────────────────────────────────────────
const sseClients = new Set();

let batch = {
  running: false,
  cancelRequested: false,
  current: 0,
  total: 0,
};

// ── Utilities ──────────────────────────────────────────────────

function expandUser(p) {
  if (typeof p !== 'string') return p;
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  if (p.startsWith('$HOME')) return path.join(os.homedir(), p.slice(5));
  return p;
}

function jsonReply(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data, null, 2));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (_) { resolve({}); }
    });
  });
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

// ── SSE helpers ────────────────────────────────────────────────

function sseBroadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (_) { sseClients.delete(res); }
  }
}

// ── Dreamina CLI wrappers ──────────────────────────────────────

/**
 * Spawn dreamina, collect stdout/stderr, resolve with {stdout, stderr, code}.
 * Rejects on spawn failure; non-zero exit is NOT rejected (caller inspects code).
 */
function runDreamina(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('dreamina', args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { const s = d.toString(); stdout += s; if (opts.onStdout) opts.onStdout(s); });
    child.stderr.on('data', (d) => { const s = d.toString(); stderr += s; if (opts.onStderr) opts.onStderr(s); });

    child.on('error', (err) => reject(new Error(`无法启动 dreamina: ${err.message}`)));
    child.on('close', (code) => resolve({ stdout, stderr, code: code || 0 }));

    if (opts.returnChild) opts.returnChild(child);
  });
}

function parseDreaminaJSON(output) {
  try { const parsed = JSON.parse(output.trim()); return parsed; } catch (_) {}
  const lines = output.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try { const parsed = JSON.parse(line); if (parsed.gen_status) return parsed; } catch (_) {}
  }
  return null;
}

function extractSubmitId(output) {
  const parsed = parseDreaminaJSON(output);
  if (parsed && parsed.submit_id) return parsed.submit_id;
  const m = output.match(/"submit_id"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function extractGenStatus(output) {
  const parsed = parseDreaminaJSON(output);
  if (parsed && parsed.gen_status) return parsed.gen_status;
  const m = output.match(/"gen_status"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function extractFailReason(output) {
  const parsed = parseDreaminaJSON(output);
  if (parsed && parsed.fail_reason) return parsed.fail_reason;
  const m = output.match(/"fail_reason"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

// ── Dreamina status checks ─────────────────────────────────────

async function checkDreaminaInstalled() {
  const { stdout, code } = await runDreamina(['--version']);
  return { installed: code === 0, version: stdout.trim() };
}

async function checkDreaminaLoggedIn() {
  const { stdout, stderr, code } = await runDreamina(['user_credit']);
  const combined = stdout + stderr;
  if (code !== 0) return { loggedIn: false, reason: combined.trim() };
  try {
    const parsed = JSON.parse(stdout.trim());
    return { loggedIn: true, total_credit: parsed.total_credit, user_id: parsed.user_id, user_name: parsed.user_name || '', vip_level: parsed.vip_level || '' };
  } catch (_) { if (/\d/.test(stdout)) return { loggedIn: true, total_credit: stdout.trim() }; }
  if (/login|auth|token|credential|unauthorized/i.test(combined)) return { loggedIn: false, reason: combined.trim() };
  return { loggedIn: false, reason: '无法确认登录状态' };
}

// ── Login flow helpers ─────────────────────────────────────────

async function startHeadlessLogin() {
  const { stdout, stderr } = await runDreamina(['login', '--headless']);
  const combined = stdout + stderr;
  if (/已复用|已登录|already|reusing|existing session/i.test(combined)) return { alreadyLoggedIn: true, raw: combined };
  const uriMatch  = combined.match(/verification_uri[:\s]+(\S+)/i) || combined.match(/(https?:\/\/[^\s]+verify[^\s]*)/i) || combined.match(/(https?:\/\/[^\s]+device[^\s]*)/i) || combined.match(/(https?:\/\/[^\s]+activate[^\s]*)/i);
  const codeMatch = combined.match(/user_code[:\s]+([A-Z0-9]{4,}-?[A-Z0-9]{0,4})/i) || combined.match(/([A-Z0-9]{4,8}-[A-Z0-9]{4,8})/);
  const devMatch  = combined.match(/device_code[:\s]+([A-Za-z0-9_-]{20,})/i);
  return { raw: combined, verification_uri: uriMatch ? uriMatch[1] : null, user_code: codeMatch ? codeMatch[1] : null, device_code: devMatch ? devMatch[1] : null, alreadyLoggedIn: false };
}

async function pollCheckLogin(deviceCode, pollSec = 10) {
  const { stdout, stderr, code } = await runDreamina(['login', 'checklogin', `--device_code=${deviceCode}`, `--poll=${pollSec}`]);
  return { success: code === 0, output: stdout + stderr };
}

// ── Batch generation engine ────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pollUntilDone(submitId, taskIndex, total, filename) {
  const MAX_POLLS = 120;
  for (let i = 0; i < MAX_POLLS; i++) {
    if (batch.cancelRequested) return { cancelled: true };
    const { stdout, stderr } = await runDreamina(['query_result', `--submit_id=${submitId}`]);
    const combined = stdout + stderr;
    const status = extractGenStatus(combined);
    if (status === 'success') return { done: true, output: combined };
    if (status === 'fail') { const reason = extractFailReason(combined); return { done: false, failed: true, reason: reason || '未知失败原因' }; }
    sseBroadcast('progress', { index: taskIndex, total, filename, status: 'generating', submitId, message: `[${taskIndex + 1}/${total}] 等待生成: ${filename} (轮询 ${i + 1}/${MAX_POLLS})` });
    await sleep(10_000);
  }
  return { done: false, failed: true, reason: '生成超时（超过20分钟）' };
}

async function executeBatch(tasks, options) {
  const total = tasks.length;
  const results = [];
  batch = { running: true, cancelRequested: false, current: 0, total, results };

  for (let i = 0; i < total; i++) {
    if (batch.cancelRequested) { sseBroadcast('cancelled', { message: '批量生成已取消', completed: results.length, total }); break; }
    batch.current = i;
    const task  = tasks[i];
    const fname = path.basename(task.imagePath);
    const resolvedImagePath = expandUser(task.imagePath);

    sseBroadcast('progress', { index: i, total, filename: fname, status: 'submitting', message: `[${i + 1}/${total}] 提交: ${fname}` });

    let submitId;
    try {
      const { stdout, stderr, code } = await runDreamina(['multimodal2video', `--image=${resolvedImagePath}`, `--model_version=${options.model}`, `--ratio=${options.ratio}`, `--duration=${options.duration}`, `--prompt=${task.prompt}`, `--video_resolution=${options.resolution}`, '--poll=0'], { timeout: 120_000 });
      const combined = stdout + stderr;
      if (code !== 0) throw new Error(`dreamina 退出码 ${code}: ${combined.slice(0, 300)}`);
      submitId = extractSubmitId(combined);
      if (!submitId) { const failReason = extractFailReason(combined); if (failReason) throw new Error(failReason); throw new Error(`无法解析 submit_id，原始输出: ${combined.slice(0, 300)}`); }
      const immediateStatus = extractGenStatus(combined);
      if (immediateStatus === 'fail') { const reason = extractFailReason(combined) || '未知失败原因'; throw new Error(reason); }
    } catch (err) {
      results.push({ success: false, filename: fname, outputName: task.outputName, error: err.message });
      sseBroadcast('progress', { index: i, total, filename: fname, status: 'error', message: `[${i + 1}/${total}] 提交失败: ${fname} — ${err.message}` });
      continue;
    }

    sseBroadcast('progress', { index: i, total, filename: fname, status: 'generating', submitId, message: `[${i + 1}/${total}] 生成中: ${fname} (${submitId})` });
    const pollResult = await pollUntilDone(submitId, i, total, fname);
    if (pollResult.cancelled) { sseBroadcast('cancelled', { message: '批量生成已取消', completed: results.length, total }); break; }
    if (pollResult.failed) {
      results.push({ success: false, filename: fname, outputName: task.outputName, submitId, error: pollResult.reason });
      sseBroadcast('progress', { index: i, total, filename: fname, status: 'error', message: `[${i + 1}/${total}] 生成失败: ${fname} — ${pollResult.reason}` });
      continue;
    }

    sseBroadcast('progress', { index: i, total, filename: fname, status: 'downloading', submitId, message: `[${i + 1}/${total}] 下载中: ${fname}` });
    try {
      const imageDir = path.dirname(resolvedImagePath);
      const outputDir = path.join(imageDir, 'output');
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      const { stdout, stderr, code } = await runDreamina(['query_result', `--submit_id=${submitId}`, `--download_dir=${outputDir}`], { timeout: 300_000 });
      if (code !== 0) throw new Error(`下载失败，退出码 ${code}: ${(stdout + stderr).slice(0, 200)}`);
      const sourceFile = path.join(outputDir, `${submitId}_video_1.mp4`);
      const targetFile = path.join(outputDir, `${task.outputName}.mp4`);
      if (fs.existsSync(sourceFile)) { if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile); fs.renameSync(sourceFile, targetFile); }
      else { const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.mp4')); const newest = files.map(f => ({ name: f, mtime: fs.statSync(path.join(outputDir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0]; if (newest && path.join(outputDir, newest.name) !== targetFile) { if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile); fs.renameSync(path.join(outputDir, newest.name), targetFile); } }
      results.push({ success: true, filename: fname, outputName: task.outputName, submitId, outputPath: targetFile });
      sseBroadcast('progress', { index: i, total, filename: fname, status: 'done', submitId, message: `[${i + 1}/${total}] 完成: ${fname} → output/${task.outputName}.mp4` });
    } catch (err) {
      results.push({ success: false, filename: fname, outputName: task.outputName, submitId, error: err.message });
      sseBroadcast('progress', { index: i, total, filename: fname, status: 'error', message: `[${i + 1}/${total}] 下载失败: ${fname} — ${err.message}` });
    }
  }
  batch.running = false;
  const ok = results.filter(r => r.success).length;
  sseBroadcast('complete', { total, success: ok, failed: total - ok, results });
  return results;
}

// ── HTTP Server ────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;
  const pn     = url.pathname;

  if (method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }

  if (method === 'GET' && (pn === '/' || pn === '/index.html')) {
    try { const html = fs.readFileSync(HTML_FILE, 'utf-8'); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html); } catch (err) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('无法加载 HTML 文件: ' + err.message); }
  }

  if (method === 'GET' && pn === '/api/server-path') { return jsonReply(res, 200, { path: SCRIPT_DIR }); }
  if (method === 'GET' && pn === '/api/health') { return jsonReply(res, 200, { ok: true, time: Date.now() }); }
  if (method === 'GET' && pn === '/api/dreamina/status') { const inst = await checkDreaminaInstalled(); if (!inst.installed) return jsonReply(res, 200, { installed: false, loggedIn: false, error: 'dreamina CLI 未安装或不在 PATH 中' }); const login = await checkDreaminaLoggedIn(); return jsonReply(res, 200, { installed: true, version: inst.version, ...login }); }
  if (method === 'POST' && pn === '/api/dreamina/login') { try { const info = await startHeadlessLogin(); if (info.alreadyLoggedIn) return jsonReply(res, 200, { success: true, alreadyLoggedIn: true, message: '已处于登录状态' }); if (!info.verification_uri || !info.user_code || !info.device_code) return jsonReply(res, 500, { success: false, error: '无法解析 dreamina login 输出，请手动在终端运行 dreamina login', raw: info.raw }); return jsonReply(res, 200, { success: true, ...info }); } catch (err) { return jsonReply(res, 500, { success: false, error: err.message }); } }
  if (method === 'POST' && pn === '/api/dreamina/login/check') { const body = await readBody(req); if (!body.device_code) return jsonReply(res, 400, { success: false, error: '缺少 device_code' }); const result = await pollCheckLogin(body.device_code, 5); return jsonReply(res, 200, result); }
  if (method === 'POST' && pn === '/api/dreamina/logout') { try { await runDreamina(['logout']); } catch (e) {} return jsonReply(res, 200, { success: true }); }
  if (method === 'POST' && pn === '/api/batch/start') { if (batch.running) return jsonReply(res, 409, { error: '已有批处理任务正在运行' }); const login = await checkDreaminaLoggedIn(); if (!login.loggedIn) return jsonReply(res, 401, { error: 'NOT_LOGGED_IN', message: '请先登录 Dreamina' }); const body = await readBody(req); const { tasks, options } = body; if (!tasks || !Array.isArray(tasks) || tasks.length === 0) return jsonReply(res, 400, { error: '缺少 tasks 数据' }); jsonReply(res, 200, { success: true, message: '批处理已启动', total: tasks.length }); executeBatch(tasks, options).catch(err => { console.error('Batch fatal error:', err); sseBroadcast('error', { message: `批处理致命错误: ${err.message}` }); batch.running = false; }); return; }
  if (method === 'GET' && pn === '/api/batch/status') { return jsonReply(res, 200, { running: batch.running, current: batch.current, total: batch.total }); }
  if (method === 'POST' && pn === '/api/batch/cancel') { if (!batch.running) return jsonReply(res, 200, { success: false, message: '没有正在运行的批处理任务' }); batch.cancelRequested = true; return jsonReply(res, 200, { success: true, message: '取消请求已发送，将在当前任务完成后停止' }); }

  if (method === 'GET' && pn === '/api/batch/progress') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write(':ok\n\n'); sseClients.add(res); req.on('close', () => sseClients.delete(res)); return;
  }

  jsonReply(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n即梦批量视频生成 · Server\n地址: http://127.0.0.1:${PORT}\n按 Ctrl+C 停止服务器\n`);
});
