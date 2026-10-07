# JASync

Just another S3 sync plugin for Obsidian. Preview and select changes before syncing notes with S3-compatible storage, with conflict handling and local recovery backups.

基于 Obsidian Nutstore Sync 的同步交互，采用 Alipan RemoteStorage 抽象方式开发的 **S3-only** 插件。插件 ID 和安装目录统一使用 `jasync`。

**截至 2026-10-07，当前版本为 [1.0.1](https://github.com/guojuntech/obisidian-jasync/releases/tag/1.0.1)。** 已实现可执行的 S3 同步：扫描、比较、预览并勾选文件，确认后执行上传、下载、覆盖、删除和冲突处理。移动端兼容修复持续推进，Android / iOS 完整同步仍待实机验收。

## 当前进展

| 方向         | 当前状态                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S3 后端      | 支持 Endpoint、Region、Bucket、Prefix、临时令牌及两种寻址方式；Prefix 是唯一远端根目录，Path Style 默认关闭。                                          |
| 同步策略     | 支持双向、仅发送、仅接收，以及覆盖远端 / 还原本地策略；提供文件筛选、冲突处理和逐文件同步记录。                                                        |
| 执行保护     | 完整分页与内容比较、可勾选计划、目标及版本复核、条件写删能力探测、覆盖 / 删除前恢复备份；失败或取消不把未完成项目记为已同步。                          |
| 性能与进度   | 扫描、比较、复核、传输及记录维护持续显示进度；已有匹配基准的未变化文件跳过重复 Recheck / Verify。                                                      |
| Android 兼容 | 已修复启动时的 `Buffer is not defined`；删除探测改用 GET 验证，特定 HEAD 原生异常可通过 Range GET 补查。已有隔离环境回归，尚未完成 Android 真机验收。  |
| 排障         | 支持日志导出、请求关联 ID、S3/COS 错误信息及默认关闭的 Verbose log；可区分原生请求、响应元数据和响应正文读取失败。                                     |
| 界面         | 使用 JA 同步图标；同步结束后 Stop sync 保持可见但灰色禁用，成功后的 Close 为绿色白字。AI 设置页和 ChatBox 左侧入口隐藏，笔记顶部 AI 冲突处理按钮停用。 |
| 分发         | GitHub Release 提供 BRAT 所需独立文件、手动安装 ZIP 和 SHA-256 清单；Tag 发布工作流校验版本、测试、构建及安装包内容。                                  |

坚果云 SSO、WebDAV、增量接口、远端缓存和 AI 网关已移除；通用 AI/MCP 代码仍保留。详细架构与执行边界见 [DESIGN.md](DESIGN.md)。

### 最近版本

| 版本                              | 主要进展                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [1.0.1](docs/releases/1.0.1.md)   | 当前文件名区域保留一行高度，修复文件切换和同步结束时的进度窗口抖动。                                                          |
| [1.0.0](docs/releases/1.0.0.md)   | 将既有 S3 同步实现发布为 1.0.0，补齐社区提交所需的网络使用说明；插件身份和数据格式保持不变。                                  |
| [0.2.12](docs/releases/0.2.12.md) | 停用 AI 冲突按钮，完善同步完成后的按钮状态与颜色。                                                                            |
| [0.2.11](docs/releases/0.2.11.md) | Android HEAD 在原生层丢失响应时，针对特定 `Stream closed` 异常补发 `GET Range: bytes=0-0`；保留真实状态、对象大小和版本检查。 |
| [0.2.10](docs/releases/0.2.10.md) | 增加可即时开关的 S3 详细日志，覆盖成功 / 失败请求及原生处理阶段。                                                             |
| [0.2.9](docs/releases/0.2.9.md)   | 删除能力探测改用 GET 确认对象消失，必须收到明确的 HTTP 404 才通过。                                                           |
| [0.2.8](docs/releases/0.2.8.md)   | 增加 S3 请求诊断和日志笔记导出。                                                                                              |
| [0.2.7](docs/releases/0.2.7.md)   | 移除导致 Android 启动失败的 XML 校验依赖链，补充无 Node 全局对象的回归检查。                                                  |

## 安装与升级

GitHub Release 可独立安装；Obsidian 官方社区目录注册尚未完成，不能据此在应用内搜索安装。

最低 Obsidian 版本为 **1.7.2**。通过 BRAT 添加仓库 **`guojuntech/obisidian-jasync`**，选择已发布版本并启用 JASync。注意 GitHub 仓库名中的拼写是 `obisidian`。

手动安装可从 [1.0.1 Release](https://github.com/guojuntech/obisidian-jasync/releases/tag/1.0.1) 下载 `jasync-1.0.1.zip`，解压到笔记库的 `.obsidian/plugins/`。结构应为：

```text
.obsidian/plugins/jasync/
├── main.js
├── manifest.json
├── styles.css
├── LICENSE
└── NOTICE.md
```

使用自定义 Obsidian 配置目录时，以该目录替代 `.obsidian`。ZIP 顶层已经包含 `jasync/`，避免重复嵌套目录。

- **新设备**：启用后独立填写 S3 配置。同一笔记库使用相同 Bucket / Prefix；各设备独立生成身份和同步记录，不复制其他设备的 `data.local.json`、cache 或 recovery。新空库可先用普通 Receive Only 下载，再切换 Two Way。
- **已有 `jasync` 安装**：先禁用插件，覆盖发布文件，保留本设备的 `data.json`、`data.local.json`、cache 和 recovery，再启用或重启 Obsidian。
- **从旧插件 ID 切换**：采用全新卸载安装，不迁移旧配置、缓存或同步记录。重新配置后首次同步需审核计划；清理插件状态不涉及笔记正文或 S3 对象。旧名称只用于私有文件排除，避免遗留状态进入同步。

## 使用 S3 同步

1. 填写 Endpoint、Region、Bucket、Prefix 和密钥。AWS Endpoint 可留空；Path Style 默认关闭，使用虚拟主机寻址，兼容服务按需开启。
2. 点击「检查连接」，再点击左侧 **Start JASync**。账号权限需要覆盖指定 Prefix 的列举、读取、写入和删除。
3. 扫描比较后，检查同步计划并勾选文件，点击 **Confirm and sync / 确认并同步**。关闭或取消计划窗口不会执行文件写删。
4. 若服务不支持所需条件写删，会显示额外的兼容模式确认。本次执行保留备份和写入前复核，但无法消除其他客户端同时修改造成的竞争；自动同步不会进入兼容模式。

进度窗口的 **Hide / 关闭** 只隐藏界面，不停止同步；使用 **Stop sync** 才会请求取消。取消会停止后续工作，已经发出的网络请求需返回或超时，已完成的文件不会自动回滚。

覆盖、删除和冲突处理前，原内容保存在 `.obsidian/plugins/jasync/recovery/<本次编号>/`。备份失败、计划过期或权限错误会停止执行，已完成的文件保留准确记录。恢复步骤见 [实施记录](docs/IMPLEMENTATION.md#recovery)。

自动同步默认关闭，可配置实时、启动及定时触发。冲突、受保护的删除、一次至少 10 个文件的删除及不支持条件写入的操作留待手动审核。从早期只读版本升级时会关闭旧的自动触发设置。

## 排查同步问题

在 **设置 → JASync → 排障（Troubleshoot）** 中开启 **Verbose log（S3 详细日志）**，清空旧日志，复现一次，再点击 **控制台日志 → 保存到笔记**。日志保存到 `jasync/logs/` 并自动打开；请在重启或禁用插件前导出。

详细日志默认关闭，仅保存在当前设备，切换后对后续请求立即生效。内存最多保留最近 2000 条；凭据、签名和令牌脱敏，笔记正文不记录，但详细模式包含 Bucket、Prefix 和文件名。

Android 上仅在 HEAD 请求尚未交付响应、且出现特定 `Request Failed. IOException Stream closed` 异常时自动补查，不依赖 Verbose log。补查的真实 404 才按不存在处理；403 等错误仍会失败。服务端忽略 Range 时，补查可能下载整个对象。日志字段与定位方法见 [S3 诊断指南](docs/S3-DIAGNOSTICS.md)。

## 网络使用、账号与数据

JASync 本身免费，不要求 JASync 或坚果云账号。S3 同步需要自行提供存储服务及凭据；云服务账号、存储和流量费用由所选服务提供商决定。

- **S3**：仅向配置的 Endpoint（或按 Region 确定的 AWS S3 地址）发送签名请求，用于连接检查、列举、读写删除以及随机私有对象的能力探测；文件名和选中的文件内容会发送到该存储服务。检查连接只验证访问，真正的同步写删由已确认计划或主动开启的自动同步触发。
- **保留的 AI/MCP 功能**：AI 设置页和左侧 ChatBox 入口当前隐藏，AI 冲突按钮停用，但通用代码及命令仍保留。用户配置并使用 AI 时，会把对话、附加上下文和工具结果发送到指定模型服务；启用的 MCP 服务会在加载配置时连接所配置的服务器，工具调用将参数发送到该服务器。手动刷新模型目录时访问 `https://models.dev/api.json`。这些功能不属于 S3 同步的必要条件，可能需要第三方账号或付费 API。
- **本地数据**：配置、同步记录和恢复副本存放在当前 vault 的插件目录；S3 凭据保存在未加密的 `data.local.json`。诊断日志保存在内存，用户导出后写入 vault 的 `jasync/logs/`。插件未添加客户端遥测或广告。

## 验证状态与剩余工作

[1.0.0 发布验证](docs/releases/1.0.0.md)：**71 个单元测试文件 / 903 项测试、19 项原生桌面 Obsidian 检查**，以及 ESLint、TypeScript、生产构建和 ZIP 五文件内容校验通过。生产包检查包含无 Node 全局对象的浏览器环境、实际界面控件和日志导出。

[0.2.11 实施记录](docs/IMPLEMENTATION.md#0211--android-head-response-compatibility)另记录 **7 个真实 COS 场景**通过；其中 Android 原生 HEAD 响应丢失边界采用模拟，不能等同于手机实机测试。这些是已记录的版本验收范围，并非所有 S3 服务的兼容承诺。

尚待完成或存在的边界：

- Android / iOS 完整生命周期和真实同步的实机验收，以及 AWS / 其他兼容 S3 服务的覆盖；COS 的已有场景不代表全部功能与条件语义均已验证。
- 每个文件整体缓存在内存，默认跳过大于 30 MB 的文件；未实现分片上传、断点续传和历史版本浏览。
- 恢复副本需手动管理，没有自动过期或恢复界面；整次同步不是全库事务。
- `data.local.json` 中的凭据当前未加密。插件配置、同步记录、恢复副本及临时探测对象强制排除在同步之外。
- 首次同步和变化文件仍需内容比较、版本复核及必要备份；后续性能优化需保留这些保护。

## 开发与测试

需要 Node.js 22+、pnpm 9.15.9 和 Git LFS。`src/ai/models-api.json` 是上游 LFS 文件，构建前必须获取真实内容，不能保留 pointer 文本。

```sh
git lfs install --local
git lfs pull
corepack pnpm@9.15.9 install --frozen-lockfile
corepack pnpm@9.15.9 run test:unit
corepack pnpm@9.15.9 run build
```

已配置 `github` 上游 remote 时，缺失的上游 LFS 对象可用 `git lfs pull github` 获取。依赖全部来自公开 npm，不需要 GitHub Packages 私有包权限。

构建将最终的 `main.js`、`manifest.json`、`styles.css`、LICENSE 和 NOTICE.md 整理到 `dist/`，生成以 `jasync/` 为顶层目录的 `jasync-<version>.zip`。项目根目录也保留产物，供集成测试和发布使用。

单元测试使用可控 S3 协议实现；Obsidian 集成测试使用隔离测试库和假密钥，不接触个人笔记或真实云端：

```sh
# Linux 沙箱（默认）
corepack pnpm@9.15.9 run test:obsidian
# macOS 已安装 Obsidian 时，使用独立 profile 和临时测试库
corepack pnpm@9.15.9 run test:obsidian -- --native
```

发布时同步更新 package.json、manifest.json、versions.json，在 [CHANGELOG.md](CHANGELOG.md) 顶部记录版本日期和主要变更，并添加 `docs/releases/<version>.md`。推送同名版本 Tag 后，GitHub Actions 使用冻结锁文件运行测试和构建，核对 ZIP、生成 SHA-256 清单并发布 Release。普通分支 push 不发布安装包。

## 文档、来源与许可

- [设计与实现状态](DESIGN.md)
- [实施记录、执行保障与恢复方法](docs/IMPLEMENTATION.md)
- [S3 诊断指南](docs/S3-DIAGNOSTICS.md)
- [更新日志](CHANGELOG.md)
- [版本说明](docs/releases/)

保留 AGPL-3.0 许可及来源说明，见 [LICENSE](LICENSE) 和 [NOTICE.md](NOTICE.md)。

- 主上游：[nutstore/obsidian-nutstore-sync](https://github.com/nutstore/obsidian-nutstore-sync)
- 抽象参考：[nowszhao/obsidian-alipan-sync](https://github.com/nowszhao/obsidian-alipan-sync)

本项目提交信息以 `[guojuntech]` 开头，便于区分上游改动。
