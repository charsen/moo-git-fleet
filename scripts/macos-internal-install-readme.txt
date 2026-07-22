Moo Fleet 0.1.2 内测安装说明

适用设备：Apple Silicon Mac，macOS 13.5 或更高版本。

推荐安装方式

1. 先退出正在运行的 Moo Fleet。
2. 双击“安装 Moo Fleet（内测）.command”。
3. 如 macOS 拦截脚本，请在 Finder 中右键该脚本，选择“打开”，再确认一次。
4. 如系统要求管理员密码，请按提示授权写入“应用程序”目录。

辅助安装器只会：

- 校验 Moo Fleet 的 Bundle ID、主程序和签名完整性；
- 如果“应用程序”目录已有同名但不同 Bundle ID 的 App，会拒绝覆盖并保留原 App；
- 将 App 安装到 /Applications；
- 只清除 Moo Fleet App 自身的下载隔离属性；
- 使用时间戳目录保留原安装版本，然后启动新版本。

辅助安装器不会关闭 Gatekeeper、不会修改 SIP，也不会重新签名。如提示 Moo Fleet 或后台服务仍在运行，请退出应用、稍等片刻后重试；如提示另一个安装进程正在执行，请等待该安装结束。安装完成但自动启动失败时，可直接从“应用程序”目录打开。安装器不会自动结束进程。

也可以跳过辅助安装器，手动将“Moo Fleet.app”拖到“Applications”。当前 DMG 使用 ad-hoc 签名，仅供可信来源的内部测试；正式公开分发仍需要 Developer ID 签名和 Apple 公证。
