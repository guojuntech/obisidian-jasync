# JASync

Just another S3 sync plugin for Obsidian. 仓库名为 `obsidian-jasync`；插件 ID 和配置目录使用 `jasync`，使用独立的配置与同步历史。

基于 Obsidian Nutstore Sync 的同步交互，使用 Alipan RemoteStorage 抽象方式开发的 **S3-only** 插件。

**当前为 0.2.6，可执行完整 S3 同步。** 扫描后展示计划，点击「确认并同步」执行勾选的上传、下载、覆盖、删除和冲突处理；取消或关闭计划不会执行。Prefix 直接在输入框中设置。

已移除坚果云 SSO、WebDAV、增量接口、远端缓存和 AI 网关。通用 AI/MCP 代码仍保留，当前隐藏 AI 设置页和左侧 ChatBox 按钮。

## 开发

需要 Node.js 22+、pnpm 9.15.9 和 Git LFS。`src/ai/models-api.json` 是上游的 LFS 文件，构建前必须获取真实内容，不能保留 pointer 文本。

```sh
git lfs install --local
git lfs pull
corepack pnpm@9.15.9 install --frozen-lockfile
corepack pnpm@9.15.9 run test:unit
corepack pnpm@9.15.9 run build
```

本地已配置 `github` 上游 remote 时，缺失的上游 LFS 对象可用 `git lfs pull github` 获取。依赖全部来自公开 npm，不需要 GitHub Packages 的私有包权限。

构建会将最终的 `main.js`、`manifest.json`、`styles.css` 及许可说明整理到 `dist/`，并生成以 `jasync/` 为顶层目录的 `jasync-<version>.zip`。将安装包解压到隔离测试 vault 的 `.obsidian/plugins/`。项目根目录仍保留构建产物，供现有集成测试和发布工作流使用。

## 安装与升级

通过 BRAT 安装时添加仓库 `guojuntech/obisidian-jasync`，选择已发布版本并启用 JASync。Release 单独提供 `main.js`、`manifest.json`、`styles.css`，同时提供手动安装 ZIP 和 SHA-256 校验文件。Android / iOS 仍需实机验证。

新设备将 `dist/` 的插件文件放到 `.obsidian/plugins/jasync/`，启用 **JASync** 后独立填写 S3 配置。不要复制其他设备的 `data.local.json`、缓存或恢复目录。

0.2.6 使用全新插件身份，不迁移旧版配置、缓存或同步记录。卸载旧插件并清理其本地状态后安装 `jasync`，重新填写 S3 配置。自动同步默认关闭，首次同步需重新建立基准并检查计划；清理本地插件不会删除 S3 对象或笔记正文。

旧名称仅保留在私有文件排除规则中，避免远端遗留的旧探测对象或旧设备的私有配置进入同步。

发布时将版本同步到 package.json、manifest.json 与 versions.json，并添加 `docs/releases/<version>.md`。推送同名版本 Tag 后，GitHub Actions 使用锁定依赖运行测试和构建，校验安装包并发布 Release；普通分支 push 不发布版本。

## 使用 S3 同步

1. 填写 endpoint、region、bucket、prefix 和密钥。AWS endpoint 可留空；Path Style 默认关闭，使用虚拟主机模式，兼容服务按需开启。
2. 点击「检查连接」，再点击左侧 **Start JASync**。权限需要覆盖指定 prefix 的列举、读取、写入和删除。
3. 检查同步计划并选择文件，点击 **Confirm and sync / 确认并同步**。只有勾选项目会执行；关闭窗口或取消会停止本次操作。
4. 不支持条件写删的服务会额外显示兼容提示，说明并发覆盖风险。确认后仅本次允许使用备份和执行前版本复核；自动同步不会进入兼容模式。

覆盖、删除和冲突处理前会保留内容到 `.obsidian/plugins/jasync/recovery/<本次编号>/`。备份失败、计划过期或权限错误会停止执行，已完成的文件保留准确记录。详情和恢复步骤见 [实施记录](docs/IMPLEMENTATION.md)。

已有共同同步记录、内容与远端版本未变化的文件，扫描比对后直接保留原记录，不再逐文件重复 Recheck / Verify；需要修改的文件仍保留写入前复核与备份。首次同步仍需建立内容基准。

自动同步默认关闭，可配置实时、启动及定时触发。冲突、受保护的删除、一次至少 10 个文件的删除及不支持条件写入的操作留待手动审核。从只读版本升级时会关闭旧的自动触发设置。

S3 配置只保存在本机 `data.local.json`，未加密且被强制排除在同步之外。当前每个文件整体缓存在内存，默认跳过大于 30 MB 的文件；尚未支持分片上传、断点续传和历史版本浏览。真实云服务及移动端仍需单独验证。

## 集成测试

单元测试使用可控的 S3 协议实现；Obsidian 集成测试使用隔离测试库和假密钥，不接触个人笔记或真实云端。

```sh
# Linux 沙箱（默认）
pnpm run test:obsidian
# macOS 已安装 Obsidian 时，使用独立 profile 和临时测试库
pnpm run test:obsidian -- --native
```

架构与执行保障见 [DESIGN.md](DESIGN.md)。

## 来源与许可

保留 AGPL-3.0 许可，见 [LICENSE](LICENSE) 和 [NOTICE.md](NOTICE.md)。

- 主上游：[nutstore/obsidian-nutstore-sync](https://github.com/nutstore/obsidian-nutstore-sync)
- 抽象参考：[nowszhao/obsidian-alipan-sync](https://github.com/nowszhao/obsidian-alipan-sync)

本项目的提交信息以 `[guojuntech]` 开头，便于区分上游改动。
