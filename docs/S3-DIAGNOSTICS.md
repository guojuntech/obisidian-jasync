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

| 删除探测的 `step` | 操作                                    |
| ----------------- | --------------------------------------- |
| `seed`            | 创建随机探测对象                        |
| `seed-fallback`   | 仅对探测对象使用已有兼容逻辑重新创建    |
| `verify-seed`     | 回读初始内容                            |
| `reject-mismatch` | 使用错误 ETag 测试是否拒绝删除          |
| `verify-rejected` | 确认对象没有被修改                      |
| `accept-match`    | 使用正确 ETag 删除                      |
| `verify-deleted`  | GET 检查对象是否不存在（0.2.8 为 HEAD） |
| `cleanup`         | 清理随机探测对象                        |

覆盖探测另有 `verify-overwrite`，用于回读覆盖后的内容。

## 如何判断

- HTTP 403 / AccessDenied：服务端拒绝请求，按 RequestId 检查授权、Bucket 策略等原因。
- `reject-mismatch` 返回 412：探测预期的拒绝结果。
- `accept-match` 返回 204、`verify-deleted` 返回 404：成功删除的预期结果。
- `native request failed (no HTTP response)`：原生请求没有向插件交付正常响应。查看 message、code、reportedStatus 和耗时，不能直接断定为 AK 权限不足。
- `S3_REQUEST_TIMEOUT`：插件等待请求超时。PUT 上限 120 秒，其他请求 30 秒；超时不能保证远端没有执行操作。
- `probe cleanup failed`：清理失败，可能留下保留探测对象；此前的主要失败原因仍被保留。

原生异常自报的 404/412 不会被直接当作探测成功或兼容模式依据；写入不会因为新增诊断而自动重试或取消条件保护。

默认模式的 S3 诊断不记录配置密钥、令牌、Authorization、完整 URL、请求正文或原始响应正文；错误 XML 只提取受限的 Code 和 RequestId。0.2.10 的可选详细模式见下文。已有同步日志仍可能包含 Bucket、Prefix 和笔记路径。日志笔记遵循现有过滤与同步规则。

0.2.8 增加可观测信息，不代表 Android 网络问题已修复。0.2.7 丢弃的原始异常无法恢复，需要升级后重新复现和导出。

0.2.9 根据 Android 的 `HEAD [delete/verify-deleted] ... IOException Stream closed` 日志，将删除探测的最终检查改为 GET，绕开这一步的 HEAD 请求。升级后应看到 `method: GET`、`step: verify-deleted`、`httpStatus: 404`。若 GET 仍抛出异常，请导出包含该 diagnosticId 的开始、响应或原生异常记录；没有 HTTP 响应时不会凭空生成 COS 错误码。此调整未替换普通文件 stat 的 HEAD，也不代表所有 Android 网络问题已解决。

## 0.2.10：Verbose log 开关

进入 **设置 → JASync → 排障 → Verbose log（S3 详细日志）**，开启后清空旧日志，再复现一次问题，立即点击 **控制台日志 → 保存到笔记**。开关默认关闭，保存在当前设备；现有会话的后续请求即可生效，无需重启。复现完成后可以关闭。

详细模式覆盖每次 ListObjectsV2 / HeadObject / GetObject / PutObject / DeleteObject，包括成功请求、普通文件请求及能力探测。所有相关行用同一 `diagnosticId` 关联，重试通过 `attempt` 区分。

| 日志                      | 新增信息                                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verbose request`         | API、方法、毫秒时间戳、URL、解码后的对象路径、查询参数、region/寻址方式、脱敏请求头、签名算法/credentialScope/signedHeaders、签名耗时、请求体是否存在及字节数、调用栈 |
| `verbose transport`       | 原生处理阶段、开始/完成/失败、累计耗时、超时上限、是否已向插件交付响应、已读取的状态码与脱敏响应头、响应体字节数、脱敏异常栈及 cause                                  |
| `verbose response`        | 请求总耗时、HTTP 状态、S3/COS Code、RequestId、脱敏响应头、响应字节数，以及错误 XML 中受限的 Message                                                                  |
| `verbose retry scheduled` | 当前状态、等待毫秒数和下一次 attempt                                                                                                                                  |
| `verbose signing failed`  | 发送前的签名失败及脱敏异常，未发出该次网络请求                                                                                                                        |

请求和响应头保留 Content-Length、Content-Encoding、Transfer-Encoding、ETag、条件头、缓存信息、请求 ID 等协议字段；Authorization、令牌、Cookie、自定义元数据和未知头值显示 `[redacted]`。签名范围仅包含日期、region、服务和终止标记，不含 AK。

### 怎样定位 Stream closed

按失败请求的 `diagnosticId` 找到 `verbose request`，确认实际 API 和对象路径，然后看最后一个 `verbose transport`：

- `stage: request-url`、`state: failed`、`responseReceived: false`：Obsidian 的 requestUrl 调用或返回的 Promise 抛错，插件没有拿到响应对象。此时无法从插件日志获取底层 HTTP 状态码，也不能推断为 COS 不支持 HEAD。
- `stage: response-metadata`、`state: failed`：requestUrl 已返回，但插件访问状态/响应头失败。
- `stage: response-arraybuffer`、`state: failed`：已读取响应元数据，访问 arrayBuffer 失败。之前记录的 `httpStatus` 和响应头可用于分析；失败仍中止操作，不将这个状态当成完整成功的响应。
- `verbose response`：插件成功读取响应；查看实际状态、服务错误码及 RequestId。

这些阶段是插件与 Obsidian API 的边界，不代表能观察 Java 内部的 socket、TLS 或响应体解码过程。0.2.10 保留普通 stat 的 HEAD 请求；0.2.11 增加下文所述的定向补查。

### 导出内容与范围

详细日志会包含 Bucket、Prefix、文件名和对象路径。凭据及实际签名会脱敏，笔记正文、列表正文、原始错误 XML、CanonicalRequest 和 StringToSign 不写入日志。最多记录 64 个请求/响应头和 64 个查询项（另带总数），一般文本字段限 512 字符，URL 限 8192、对象路径限 4096；错误 XML 只检查前 16 KiB，异常最多三层、每层 12 行栈。日志仍只保留最近 2000 条，详细模式下更容易达到上限。

导出头部增加 Verbose S3 log 开关状态及 `S3 diagnostics format: 2`。日志位于内存，重启/禁用插件后无法补导出；详细日志无法追溯开关开启前的请求。

## 0.2.11：Android HEAD 失败后的补查

补查自动生效，与 Verbose log 开关无关。仅当 Android 的 HEAD 在原生 requestUrl 阶段抛出 `Request Failed. IOException Stream closed`，尚未交付响应对象时触发。已交付响应后的读取异常、其他网络异常以及 GET/PUT/DELETE 原生失败不触发此处理。

按以下日志链检查结果：

1. 原 HEAD 的 `native request failed (no HTTP response)`：记录异常与原 diagnosticId，HTTP 状态仍然未知。
2. `HEAD response unavailable; checking with Range GET`：开始对相同对象补发 `GET Range: bytes=0-0`。
3. `HEAD fallback response`：记录补查的真实方法、HTTP 状态、serviceCode、RequestId；开启详细模式后，`verbose response` 另含脱敏 Message 与响应头。

补查使用独立 diagnosticId，以 `parentDiagnosticId` 指向最初失败的 HEAD。`fallbackReason: android-head-stream-closed` 标明触发原因；`fallbackStep: range-get` 表示 Range GET，`empty-file-head` 表示收到 416 后的单次 HEAD。HTTP 503 等仍按原有只读重试上限执行，以 attempt 区分，不循环进入补查。

GET 404 才进入不存在/目录检查。GET 403 仍然报权限或签名错误。GET 206 以 Content-Range 的总大小作为对象大小，不能把返回的一字节当作文件大小。空对象通常返回 416，再用 HEAD 获取元数据；第二次 HEAD 如果仍有原生异常则停止。服务端忽略 Range 返回 200 时校验完整响应，可能下载整个对象。请求间对象变化由后续计划复核处理，不把补查当成原请求的历史状态。

根因依据：对 [官方 Obsidian Android 1.13.8 APK](https://github.com/obsidianmd/obsidian-releases/releases/tag/v1.13.8) 的静态分析发现，其原生桥接先读取状态，再无条件读取错误流，最后才构造 JS 响应。HEAD 错误响应没有正文，错误流可为 null，读取时抛出 Stream closed，状态因此未返回插件。HEAD 403、404、412、500 都可能出现相同异常。已用最小 Java 用例和真实 COS 对照复现该处理顺序；Android 实机仍需复测。
