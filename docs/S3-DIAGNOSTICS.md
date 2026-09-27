# 查看 S3 同步诊断日志（0.2.8 起）

在 Android 或桌面端复现错误后，进入 **设置 → JASync → 排障（Troubleshoot）→ 控制台日志 → 保存到笔记**。日志保存到 `jasync/logs/jasync-logs-时间.md` 并自动打开。请在重启或禁用插件前导出：日志只在内存中保留最近 2000 条，导出头部会注明丢弃数量、插件版本、Obsidian API 版本和平台。

搜索 `[S3]`，找到 `native request failed` 或 `HTTP request failed`，按相同的 `diagnosticId` 关联请求。能力探测的每个请求都有开始和响应记录。

| 字段                           | 含义                                                         |
| ------------------------------ | ------------------------------------------------------------ |
| `method`                       | GET、HEAD、PUT 或 DELETE                                     |
| `capability`                   | create、overwrite 或 delete；普通请求没有此字段              |
| `step`                         | 具体探测步骤，见下表                                         |
| `diagnosticId` / `attempt`     | 一次逻辑请求的关联 ID 和只读请求重试次数                     |
| `elapsedMs`                    | 底层请求耗时                                                 |
| `httpStatus`                   | 正常收到响应时的 HTTP 状态码                                 |
| `serviceCode`                  | S3/COS 错误 XML 中的 Code，例如 AccessDenied                 |
| `requestId`                    | COS/AWS 响应头或错误 XML 中的请求 ID                         |
| `nativeError`                  | 脱敏后的异常名称、消息、code，以及最多三层原因               |
| `nativeError[].reportedStatus` | 原生异常自报的 status/statusCode，不等于已收到正常 HTTP 响应 |

| 删除探测的 `step` | 操作                                 |
| ----------------- | ------------------------------------ |
| `seed`            | 创建随机探测对象                     |
| `seed-fallback`   | 仅对探测对象使用已有兼容逻辑重新创建 |
| `verify-seed`     | 回读初始内容                         |
| `reject-mismatch` | 使用错误 ETag 测试是否拒绝删除       |
| `verify-rejected` | 确认对象没有被修改                   |
| `accept-match`    | 使用正确 ETag 删除                   |
| `verify-deleted`  | HEAD 检查对象是否不存在              |
| `cleanup`         | 清理随机探测对象                     |

覆盖探测另有 `verify-overwrite`，用于回读覆盖后的内容。

## 如何判断

- HTTP 403 / AccessDenied：服务端拒绝请求，按 RequestId 检查授权、Bucket 策略等原因。
- `reject-mismatch` 返回 412：探测预期的拒绝结果。
- `accept-match` 返回 204、`verify-deleted` 返回 404：成功删除的预期结果。
- `native request failed (no HTTP response)`：原生请求没有向插件交付正常响应。查看 message、code、reportedStatus 和耗时，不能直接断定为 AK 权限不足。
- `S3_REQUEST_TIMEOUT`：插件等待请求超时。PUT 上限 120 秒，其他请求 30 秒；超时不能保证远端没有执行操作。
- `probe cleanup failed`：清理失败，可能留下保留探测对象；此前的主要失败原因仍被保留。

原生异常自报的 404/412 不会被直接当作探测成功或兼容模式依据；写入不会因为新增诊断而自动重试或取消条件保护。

新增 S3 诊断不记录配置密钥、令牌、Authorization、完整 URL、请求正文或原始响应正文；错误 XML 只提取受限的 Code 和 RequestId。已有同步日志仍可能包含 Bucket、Prefix 和笔记路径。日志笔记遵循现有过滤与同步规则。

0.2.8 增加可观测信息，不代表 Android 网络问题已修复。0.2.7 丢弃的原始异常无法恢复，需要升级后重新复现和导出。
