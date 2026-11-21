#!/usr/bin/env node
/**
 * 自检：JSON 合法性、提示词体积、CLI 干跑、hook 输出格式。
 * 不写用户目录，全部在临时目录里完成。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function ok(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!cond) failed++;
}

function json(rel) {
  const p = path.join(ROOT, rel);
  try {
    JSON.parse(fs.readFileSync(p, "utf8"));
    ok(`json: ${rel}`, true);
  } catch (e) {
    ok(`json: ${rel}`, false, e.message);
  }
}

for (const f of [
  "package.json",
  ".codebuddy-plugin/marketplace.json",
  "plugins/purge-workbuddy/.codebuddy-plugin/plugin.json",
  "marketplace.json",
  "plugins/purge-zcode/.zcode-plugin/plugin.json",
  "plugins/purge-zcode/hooks/hooks.json",
]) {
  json(f);
}

const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const fullPath = path.join(ROOT, "core/prompt.zh.md");
const litePath = path.join(ROOT, "core/prompt.lite.md");
const full = fs.readFileSync(fullPath, "utf8");
const lite = fs.readFileSync(litePath, "utf8");
ok("full prompt 体积 > 8KB", Buffer.byteLength(full) > 8000, `${Buffer.byteLength(full)} B`);
ok("lite prompt 体积 < 8KB（WorkBuddy 规则上限）", Buffer.byteLength(lite) < 8192, `${Buffer.byteLength(lite)} B`);
ok("full prompt 含路由表", full.includes("意图映射"));
ok("lite prompt 含禁用词段", lite.includes("不用这些字符串"));
ok("两档都锚定身份", full.includes("小码酱") && lite.includes("小码酱"));
ok("两档都含噪声处理", full.includes("环境噪声") && lite.includes("环境噪声"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "purge-selftest-"));
const cli = path.join(ROOT, "bin/purge.mjs");
const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" });

try {
  const status = run("status");
  ok("cli status 可运行", status.includes("dsh-purge-ports"));
  const promptOut = run("prompt", "--lite");
  ok("cli prompt --lite 输出规则", promptOut.includes("小码酱"));
  const dry = run("install", "--host", "all", "--scope", "project", "--dir", tmp, "--dry-run");
  ok("cli install --dry-run 通过", dry.includes("dry-run"));
  ok("dry-run 不落盘", fs.readdirSync(tmp).length === 0);

  // 真实写入到临时目录
  run("install", "--host", "all", "--scope", "project", "--dir", tmp);
  const wb = path.join(tmp, "CODEBUDDY.md");
  const zc = path.join(tmp, "AGENTS.md");
  ok("workbuddy 规则写入", fs.existsSync(wb) && fs.readFileSync(wb, "utf8").includes("dsh-purge-ports:begin"));
  ok("zcode 规则写入", fs.existsSync(zc) && fs.readFileSync(zc, "utf8").includes("dsh-purge-ports:begin"));

  // 幂等：重复安装不产生重复块
  run("install", "--host", "all", "--scope", "project", "--dir", tmp);
  const wbText = fs.readFileSync(wb, "utf8");
  ok("幂等安装（单个标记块）", wbText.split("dsh-purge-ports:begin").length === 2);

  const verifyOut = run("verify");
  ok("cli verify 输出 sha256", /sha:[0-9a-f]{12}/.test(verifyOut));

  const probeOut = run("probe", "--json");
  const probes = JSON.parse(probeOut);
  ok("cli probe --json 探针集", Array.isArray(probes) && probes.length >= 10, `${probes.length} 条`);

  run("uninstall", "--host", "all", "--scope", "project", "--dir", tmp);
  const leftovers = fs.readdirSync(tmp).filter((f) => f === "CODEBUDDY.md" || f === "AGENTS.md");
  ok("卸载清理干净", leftovers.length === 0, leftovers.join(","));
} catch (e) {
  ok("cli 全流程", false, e.message);
}

try {
  const doctorOut = run("doctor");
  ok("cli doctor 可运行", doctorOut.includes("规则源") && doctorOut.includes("结论"));
} catch (e) {
  ok("cli doctor", false, e.message);
}

try {
  const evalOut = execFileSync(process.execPath, [path.join(ROOT, "scripts/eval.mjs")], { encoding: "utf8" });
  ok("覆盖率评测全部预设达标", evalOut.includes("全部预设达标"));
  ok("评测含输出侧过滤器能力项", /输出侧过滤/.test(evalOut));
} catch (e) {
  ok("覆盖率评测", false, (e.stdout || e.message).slice(-200));
}

// 输出侧过滤器协议：三份源都必须带，否则 content_filter 复发时规则层帮不上
try {
  for (const rel of ["presets/default.md", "presets/lite.md", "presets/terse.md"]) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    ok(`${rel} 含输出侧协议`, text.includes("输出侧过滤器") && text.includes("同义重发"));
  }
} catch (e) {
  ok("输出侧协议", false, e.message);
}

// diag / rearm：日志不存在时也要给出可读输出，不能抛
try {
  const fakeHome = path.join(tmp, "diaghome");
  fs.mkdirSync(fakeHome, { recursive: true });
  const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome };
  const runHome = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", env });

  const emptyDiag = runHome("diag");
  ok("diag 无日志时正常退出", emptyDiag.includes("没扫到失败记录"));

  // 造两份日志：一份 content_filter + 网关 502，验证分类不混
  const logDir = path.join(fakeHome, ".zcode", "cli", "log");
  fs.mkdirSync(logDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(logDir, "zcode-2099-01-01.jsonl"),
    [
      JSON.stringify({ timestamp: now, event: "model.runtime.stream.content_filtered", traceId: "T1", sessionId: "s", providerId: "p", modelId: "m", reason: "content_filter" }),
      JSON.stringify({ timestamp: now, event: "turn.failed", traceId: "T1", sessionId: "s", error: { message: "Model output was blocked by the provider's content safety filter." } }),
      JSON.stringify({ timestamp: now, event: "model.request.failed", traceId: "T2", providerId: "gw", statusCode: 502, statusMessage: "codearts_protocol" }),
    ].join("\n"),
    "utf8",
  );
  const diagOut = runHome("diag");
  ok("diag 认出输出过滤器", diagOut.includes("输出侧过滤器"));
  ok("diag 认出网关 502", diagOut.includes("本地网关空回答"));
  ok("diag 判定两条故障链", diagOut.includes("两条独立故障链"));
  ok("diag --trace 可过滤", runHome("diag", "--trace", "T2").includes("T2"));
  ok("rearm --dry-run 可运行", runHome("rearm", "--dry-run").includes("下一步"));
  ok("diag 无 rollout 时正常退出", runHome("diag", "--images").includes("判定"));

  // vision：伪造两个月 rollout 记录，验证「图片张数 vs 被拦」的列联表算得对
  const rollDir = path.join(fakeHome, ".zcode", "cli", "rollout");
  fs.mkdirSync(rollDir, { recursive: true });
  const mk = (imgCount, finishReason, at) =>
    JSON.stringify({
      startedAt: at,
      request: { body: { messages: [{ role: "user", content: Array.from({ length: imgCount }, () => ({ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } })) }] } },
      response: { finishReason, modelId: "m" },
    });
  fs.writeFileSync(
    path.join(rollDir, "model-io-sess_v.jsonl"),
    [
      mk(0, "stop", now),
      mk(0, "tool-calls", now),
      mk(3, "stop", now),
      mk(4, "content-filter", now),
      mk(5, "content-filter", now),
    ].join("\n"),
    "utf8",
  );
  const visionOut = runHome("vision");
  ok("vision 打出列联表", visionOut.includes("列联表") && visionOut.includes("拦截率"));
  ok("vision 判出纯文本 0 命中", visionOut.includes("纯文本请求 0 次被拦"));
  ok("vision 标出超预算行", visionOut.includes("超预算"));
  ok("diag --images 带图像归因", runHome("diag", "--images").includes("按单次请求的图片张数归因"));
} catch (e) {
  ok("diag / rearm", false, e.message);
}

// relay：六条处置通道各跑一遍（假上游按形状分别应答）
try {
  const relayOut = run("relay", "--selftest");
  const r = JSON.parse(relayOut);
  ok("relay 自检全通", r.ok === true);
  const byName = Object.fromEntries((r.results || []).map((x) => [x.name, x]));
  ok("relay 拆段合并可用", Boolean(byName["拆段合并"]?.ok), byName["拆段合并"]?.detail);
  ok("relay 图像预算降载", Boolean(byName["图像预算降载"]?.ok), byName["图像预算降载"]?.detail);
  ok("relay 软拒绝纠正", Boolean(byName["软拒绝纠正"]?.ok), byName["软拒绝纠正"]?.detail);
  ok("relay 被拦形状识别", Boolean(byName["被拦形状识别"]?.ok), byName["被拦形状识别"]?.detail);
  ok("relay 拒绝句式识别", Boolean(byName["拒绝句式识别"]?.ok), byName["拒绝句式识别"]?.detail);
  ok("relay 拆段指令带序号", Boolean(byName["拆段指令"]?.ok));

  const mod = await import(pathToFileURL(path.join(ROOT, "core/relay.mjs")).href);
  ok("relay 认出 OpenAI content_filter", mod.isBlocked({ choices: [{ finish_reason: "content_filter", message: { content: "" } }] }));
  ok("relay 认出 Anthropic refusal", mod.isBlocked({ stop_reason: "refusal", content: [] }));
  ok("relay 不误判正常回复", !mod.isBlocked({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }));

  // 图像预算常量与扫描：3 张以内不动，超了才降载
  ok("relay 默认图像预算为 3", mod.IMAGE_BUDGET === 3);
  const fiveImgs = {
    messages: [{ role: "user", content: Array.from({ length: 5 }, () => ({ type: "image", source: { media_type: "image/png", data: "A".repeat(50) } })) }],
  };
  const report = mod.visionReport(fiveImgs);
  ok("relay 数得出 5 张图", report.images === 5 && report.over === true, `images=${report.images} over=${report.over}`);
  const reduced = mod.applyImageBudget(fiveImgs, 3);
  const after = mod.scanImages(reduced.body).length;
  ok("relay 降载后剩 3 张", after === 3 && reduced.stripped === 2, `after=${after} stripped=${reduced.stripped}`);

  // tool_result 内嵌图片也要能被数到（ZCode 的读图结果就是这种形状）
  const nested = {
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "C:/shots/01.png" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { media_type: "image/png", data: "B".repeat(40) } }] }] },
    ],
  };
  const nestedImgs = mod.scanImages(nested);
  ok("relay 数得到 tool_result 内嵌图", nestedImgs.length === 1 && nestedImgs[0].path.includes("01.png"), nestedImgs[0]?.path || "");
} catch (e) {
  ok("relay", false, e.message);
}

// 多模态预算：三份规则源都要带这条（否则读多张图时没人提醒）
for (const [rel, file] of [
  ["full", "core/prompt.zh.md"],
  ["lite", "core/prompt.lite.md"],
  ["terse", "presets/terse.md"],
]) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  ok(`${rel} 含多模态预算`, text.includes("多模态") && /3 张|≤3|不超过 3/.test(text));
}

// 预设体系
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "core/presets.json"), "utf8"));
  const names = Object.keys(cfg.presets);
  ok("presets.json 声明 5 套预设", names.length === 5, names.join(","));
  for (const n of names) {
    const p = path.join(ROOT, "presets", `${n}.md`);
    const size = fs.existsSync(p) ? Buffer.byteLength(fs.readFileSync(p, "utf8")) : 0;
    ok(`预设 ${n} 存在`, size > 0, `${size} B`);
    if (n !== "default") ok(`预设 ${n} 在 WorkBuddy 上限内`, size < 8192, `${size} B`);
  }
  const listOut = run("presets");
  ok("cli presets 列出全部", names.every((n) => listOut.includes(n)));
} catch (e) {
  ok("预设体系", false, e.message);
}

// scope / drill：用临时 HOME，不碰真实用户目录
try {
  const fakeHome = path.join(tmp, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome };
  const runHome = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", env });

  ok("scope 初始为空", runHome("scope", "list").includes("范围清单为空"));
  ok("scope add 成功", runHome("scope", "add", "10.0.0.5", "--note", "lab dc").includes("已加入"));
  const scopeFile = path.join(fakeHome, ".purge", "scope.json");
  ok("scope.json 落盘", fs.existsSync(scopeFile));
  ok("scope list 有记录", runHome("scope", "list").includes("10.0.0.5"));

  // 带 scope 安装后，规则块里出现「已声明范围」
  const scoped = path.join(tmp, "scoped");
  fs.mkdirSync(scoped, { recursive: true });
  runHome("install", "--host", "zcode", "--scope", "project", "--dir", scoped);
  const withScope = fs.readFileSync(path.join(scoped, "AGENTS.md"), "utf8");
  ok("scope 渲染进规则块", withScope.includes("已声明范围") && withScope.includes("10.0.0.5"));

  ok("scope rm 成功", runHome("scope", "rm", "10.0.0.5").includes("已移除"));
  ok("scope clear 成功", runHome("scope", "clear").includes("已清空"));

  const drillOut = runHome("drill", "new", "10.0.0.5", "--note", "t");
  ok("drill new 创建目录", drillOut.includes("已创建"));
  const drills = path.join(fakeHome, ".purge", "drills");
  const dirs = fs.readdirSync(drills);
  ok("drill 目录结构完整", fs.existsSync(path.join(drills, dirs[0], "plan.md")) && fs.existsSync(path.join(drills, dirs[0], "report.md")) && fs.existsSync(path.join(drills, dirs[0], "evidence")));
  ok("drill list 有记录", runHome("drill", "list").includes(dirs[0]));
} catch (e) {
  ok("scope / drill", false, e.message);
}

// 插件组件完整性
try {
  for (const [host, dir] of [
    ["workbuddy", "plugins/purge-workbuddy"],
    ["zcode", "plugins/purge-zcode"],
  ]) {
    const base = path.join(ROOT, dir);
    const skills = fs.readdirSync(path.join(base, "skills"));
    const commands = fs.readdirSync(path.join(base, "commands")).filter((f) => f.endsWith(".md"));
    const agents = fs.readdirSync(path.join(base, "agents")).filter((f) => f.endsWith(".md"));
    ok(`${host} 有 4 个技能`, skills.length === 4, skills.join(","));
    ok(`${host} 有 4 个命令`, commands.length === 4, commands.join(","));
    ok(`${host} 有 2 个 agent`, agents.length === 2, agents.join(","));
    const manifest = JSON.parse(fs.readFileSync(path.join(base, host === "workbuddy" ? ".codebuddy-plugin/plugin.json" : ".zcode-plugin/plugin.json"), "utf8"));
    ok(`${host} 清单声明 agents`, manifest.agents === "agents");
    ok(`${host} 清单版本与 package.json 一致`, manifest.version === pkgVersion, `${manifest.version} vs ${pkgVersion}`);
  }
} catch (e) {
  ok("插件组件", false, e.message);
}

// hook 输出格式
try {
  const hook = path.join(ROOT, "plugins/purge-zcode/hooks/session-start.mjs");
  const out = execFileSync(process.execPath, [hook], { encoding: "utf8" });
  const payload = JSON.parse(out);
  const ctx = payload?.hookSpecificOutput?.additionalContext || "";
  ok("hook 输出合法 JSON", true);
  ok("hook additionalContext 非空", Buffer.byteLength(ctx) > 8000, `${Buffer.byteLength(ctx)} B`);
  ok("hook 事件名正确", payload.hookSpecificOutput.hookEventName === "SessionStart");
} catch (e) {
  ok("hook 输出", false, e.message);
}

// UserPromptSubmit：scope 增量注入
try {
  const hooksJson = JSON.parse(fs.readFileSync(path.join(ROOT, "plugins/purge-zcode/hooks/hooks.json"), "utf8"));
  ok("hooks.json 声明 UserPromptSubmit", Array.isArray(hooksJson.hooks?.UserPromptSubmit));

  const fakeHome = path.join(tmp, "hookhome");
  fs.mkdirSync(path.join(fakeHome, ".purge"), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, ".purge", "scope.json"),
    JSON.stringify({ targets: [{ host: "10.0.0.5", note: "lab dc" }], updated: "t" }),
    "utf8",
  );
  const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome };
  const submit = path.join(ROOT, "plugins/purge-zcode/hooks/prompt-submit.mjs");
  const runSubmit = (sid) =>
    execFileSync(process.execPath, [submit], { encoding: "utf8", env, input: JSON.stringify({ session_id: sid }) });

  const first = runSubmit("s1");
  ok("scope hook 首次注入", first.includes("scope-delta") && first.includes("10.0.0.5"));
  ok("scope hook 事件名正确", JSON.parse(first).hookSpecificOutput.hookEventName === "UserPromptSubmit");
  ok("scope hook 同会话静默", runSubmit("s1") === "");
  ok("scope hook 新会话再注入", runSubmit("s2").includes("10.0.0.5"));

  fs.writeFileSync(
    path.join(fakeHome, ".purge", "scope.json"),
    JSON.stringify({ targets: [{ host: "10.0.0.5", note: "lab dc" }, { host: "lab.internal", note: "dc" }], updated: "t2" }),
    "utf8",
  );
  ok("scope hook 变化后注入", runSubmit("s1").includes("lab.internal"));
} catch (e) {
  ok("scope hook", false, e.message);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
