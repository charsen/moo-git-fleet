/**
 * 判断当前页面是不是跑在 macOS 原生外壳（WKWebView）里。
 *
 * 需要一个判定的原因：浏览器能用的两条文件通道在这个外壳里都是哑的。
 * `WKUIDelegate` 没实现 `runOpenPanelWith` 时 `<input type="file">` 点不开；
 * 没有 download 分支时 `<a download>` 触发的 blob 下载既不落盘也不报错。
 * 两者都必须换成「服务端代劳」，而浏览器里那条老路还得留着（那边才是原生体验）。
 *
 * 依据用 `appearance` 消息通道：外壳建 webView 时一定会注入它（切主题要回传标题栏颜色），
 * 浏览器里不存在。比嗅探 UA 稳——UA 在 Electron、旧版 Safari 里都能自报家门。
 */
interface NativeShellCandidate {
  webkit?: {
    messageHandlers?: {
      appearance?: { postMessage?: unknown };
    };
  };
}

export function hasNativeShell(candidate: NativeShellCandidate | undefined = globalThis as NativeShellCandidate): boolean {
  return typeof candidate?.webkit?.messageHandlers?.appearance?.postMessage === 'function';
}
