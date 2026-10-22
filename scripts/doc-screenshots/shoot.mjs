/**
 * CDP 截图驱动：`node shoot.mjs <url> <scenario.json>`。
 *
 * 场景文件是一个数组，或 `{ width, height, actions }` 对象；每一步是：
 *   {"click": "<selector>"}                  点一下，等 wait 毫秒
 *   {"hover": "<selector>"}                  把鼠标移到元素中心（截悬停态用）
 *   {"eval":  "<js>"}                        在页面里求值，结果打到 stdout
 *   {"wait":  800}                           单纯等待
 *   {"shot":  "x.png", "anchor": "<sel>"}    截图，高度按锚点元素底边裁
 *   {"shot":  "x.png", "clip":   "<sel>"}    只截该元素自身范围（模态框用）
 *
 * `height` 只影响初始视口（默认 1000）：弹窗的 `max-height: 92dvh` 由它算出来，
 * 拍内容很长的弹窗时要调高，否则底部会被裁掉一截。
 *
 * 为什么不用 puppeteer / playwright：这两个都要往仓库里加一个几十 MB 的
 * 浏览器依赖，而截图是发版前手动跑一次的事。Chrome 自带 `--headless` +
 * `--remote-debugging-port`，Node 22 自带 `WebSocket`，够用了。
 *
 * 输出路径相对于 `MOO_FLEET_SHOT_DIR`（默认当前目录）。
 */
import fs from 'node:fs';
import path from 'node:path';

const [, , url, scenarioPath] = process.argv;
if (!url || !scenarioPath) {
  console.error('用法：node shoot.mjs <url> <scenario.json>');
  process.exit(2);
}

const shotDir = process.env.MOO_FLEET_SHOT_DIR || process.cwd();
const raw = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const actions = Array.isArray(raw) ? raw : (raw.actions ?? []);
const width = Number((Array.isArray(raw) ? undefined : raw.width) ?? 1440);
const viewportHeight = Number((Array.isArray(raw) ? undefined : raw.height) ?? 1000);

const resolveOutput = (file) => (path.isAbsolute(file) ? file : path.join(shotDir, file));

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const target = list.find((entry) => entry.type === 'page');
if (!target) throw new Error('没有可用的 page target，Chrome 是不是没带 --remote-debugging-port=9222 启动？');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
  }
};
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height: viewportHeight, deviceScaleFactor: 2, mobile: false });

await send('Page.navigate', { url });
await sleep(2600);

async function evaluate(expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails).slice(0, 400));
  return result.value;
}

async function capture(file, anchor, clipSelector) {
  const output = resolveOutput(file);
  fs.mkdirSync(path.dirname(output), { recursive: true });

  if (clipSelector) {
    // 模态框场景：只截元素自身范围，不带外面的暗背景。
    const rect = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(clipSelector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.left, y: r.top, width: r.width, height: r.height });
    })()`);
    if (!rect) throw new Error('裁剪目标不存在: ' + clipSelector);
    const box = JSON.parse(rect);
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      // scale 会和 deviceScaleFactor 相乘，这里必须是 1，否则会截出 4 倍图。
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
    });
    fs.writeFileSync(output, Buffer.from(shot.data, 'base64'));
    console.log(`${path.basename(output)}  ${Math.round(box.width)}x${Math.round(box.height)} (clip:${clipSelector})`);
    return;
  }

  // 内容底边优先用锚点区块（表格、列表面板等）的底边 + 16px 内边距。
  // 通用启发式只能兜底：整高容器带 padding 会把底部算高，截出一片空白。
  const metrics = await evaluate(`(() => {
    const anchorSel = ${JSON.stringify(anchor || null)};
    let bottom = 0;
    let source = 'none';
    if (anchorSel) {
      const el = document.querySelector(anchorSel);
      if (el) {
        bottom = el.getBoundingClientRect().bottom + window.scrollY;
        source = 'anchor:' + anchorSel;
      }
    }
    if (!bottom) {
      const vh = window.innerHeight;
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 8 || r.height >= vh * 0.9) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
        if (r.bottom > bottom) bottom = r.bottom + window.scrollY;
      }
      source = 'heuristic';
    }
    return JSON.stringify({
      bottom: Math.ceil(bottom),
      source,
      theme: document.documentElement.dataset.theme,
      overflow: document.documentElement.scrollWidth > window.innerWidth
    });
  })()`);
  const info = JSON.parse(metrics);
  const height = Math.min(Math.max(info.bottom + 16, 600), 1400);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  await sleep(500);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(output, Buffer.from(shot.data, 'base64'));
  console.log(
    `${path.basename(output)}  ${width}x${height}  (${info.source})  theme=${info.theme}  overflow=${info.overflow}`,
  );
}

for (const step of actions) {
  if (step.click) {
    const ok = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(step.click)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    console.log(`click ${step.click} -> ${ok}`);
    if (!ok) throw new Error('找不到元素: ' + step.click);
    await sleep(step.wait || 1200);
  } else if (step.hover) {
    // CSS 的 :hover 只能由真实指针事件触发，改 class 或内联样式都验证不到选择器本身。
    const point = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(step.hover)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    })()`);
    if (!point) throw new Error('找不到元素: ' + step.hover);
    const { x, y } = JSON.parse(point);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    console.log(`hover ${step.hover} -> ${x},${y}`);
    await sleep(step.wait || 500);
  } else if (step.eval) {
    const value = await evaluate(step.eval);
    console.log('eval ->', typeof value === 'string' ? value.slice(0, 300) : value);
    await sleep(step.wait || 400);
  } else if (step.wait) {
    await sleep(step.wait);
  } else if (step.shot) {
    await capture(step.shot, step.anchor, step.clip);
  }
}

ws.close();
