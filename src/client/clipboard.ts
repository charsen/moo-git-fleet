/**
 * 往剪贴板写一段文本，成功返回 `true`。
 *
 * 两条路，按「需要什么前提」排：
 * 1. `navigator.clipboard.writeText` —— 现代接口，但只在安全上下文（https / localhost）
 *    里存在；WKWebView 里窗口不是第一响应者时还会 reject；
 * 2. `document.execCommand('copy')` 配一个临时 textarea —— 废弃多年，但各内核都还留着，
 *    且不需要任何权限。
 *
 * 失败必须返回 `false`，调用方必须把这件事说出来。剪贴板静默失败是最伤人的那种失败：
 * 界面上写着「已复制」，用户粘出来却是上一次的内容，会以为是自己拿错了。
 */
export interface ClipboardDeps {
  /** 现代异步接口；不存在时传 `null`/省略，直接走兜底。 */
  writeText?: ((text: string) => Promise<void>) | null;
  /** 同步兜底写剪贴板，返回是否成功。 */
  execCopy: (text: string) => boolean;
}

export async function copyText(
  text: string,
  deps: ClipboardDeps = defaultClipboardDeps(),
): Promise<boolean> {
  if (!text) return false;
  if (deps.writeText) {
    try {
      await deps.writeText(text);
      return true;
    } catch {
      // 权限被拒 / 不是安全上下文 / 窗口失焦，都落到兜底那一条路。
    }
  }
  try {
    return deps.execCopy(text);
  } catch {
    return false;
  }
}

export function defaultClipboardDeps(): ClipboardDeps {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  return {
    writeText: typeof clipboard?.writeText === 'function'
      ? (text: string) => clipboard.writeText(text)
      : null,
    execCopy: execCopy,
  };
}

/**
 * 用临时 textarea 选区 + `execCommand('copy')`。
 *
 * 不能把 textarea 设成 `display: none` / `visibility: hidden`：那种状态下它没有选区，
 * 复制出来是空串（还是「成功」返回），比明确失败更难查。挪到视口外即可。
 */
function execCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.left = '0';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  area.setSelectionRange(0, text.length);
  try {
    return document.execCommand('copy');
  } finally {
    area.remove();
  }
}
