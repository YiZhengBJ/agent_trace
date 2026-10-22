# Trace Lab v1

2026-10-22。与 Trace Gateway 同仓库、独立进程和入口的离线实验引擎。
不更改用户 Harness，不重启网关，不在原项目目录执行工具，不读取原目录补齐缺失文件。

## 边界与分层

```text
在线网关：请求转发、轨迹采集、工具前文件备份
    ↓ 只读采样
Trace Lab 原始证据：完整起点请求、源轨迹、文件副本、重放与评估记录
    ↓ 策略专属转换
Trace Lab 策略：案例特征、正反例、阈值、留出验证、发布包
```

支持 Claude / Anthropic Messages 与 OpenAI Chat Completions 源协议的用户轮次；一个 query 可以包含多次模型调用。
端模可使用 OpenAI Chat Completions 或 Anthropic Messages JSON 接口。本版只执行 CLI 实际广告、
且与源 schema 兼容的 Read / Write / Edit 工具；支持 OpenAI 文本消息、function tool_calls 和 tool 消息；不适配 Responses API、通用 Bash（仅支持下文受限 Python 命令）、MCP、
子 agent、图片、不兼容的思考历史、目录搜索和会话压缩。其他轨迹保留为不合格证据，不伪造标签。

## 快速开始

源码仓库和统一发行包均使用同一入口；有内置 `runtime/node` 时无需系统 Node。

```sh
./scripts/trace-lab init --out /absolute/path/to/lab.json
```

编辑生成的配置：

- `traceDataDir`：指向包含 `records/`、`file-backups/` 的 Trace 数据目录。
  macOS 默认是 `~/Library/Application Support/trace-gateway/data`，配置中使用展开后的绝对路径。
- `outputDir`：独立实验目录，必须与原项目不重叠，不要设置在原项目中。
- `sourceRoot`：原项目根目录；为空时从样本请求的 cwd / 环境信息提取，不猜测公共父目录。
- `target.baseURL`、`target.model`：本地模型 API 和实际模型名，必须替换 `CHANGE_ME`。
- `target.apiKeyEnv`：密钥的环境变量名，默认 `LOCAL_LLM_API_KEY`，配置里不存密钥。
  `target.deploymentId` 可选，用于区分同名模型下的量化、serving、提示策略版本。
- `harness.command`：默认 `["claude"]`，也可指定 CLI 的绝对路径。要求支持 `--restricted`、
  `--bare`、`--permission-prompts`；本机验证版本为 Claude Code 2.1.304。
  CLI 默认保留源 request 的模型名，以尽量保持模型相关工具配置；可通过 `harness.model` 覆盖。
  这不决定推理后端，代理始终将请求改写到 `target.model` 和指定 endpoint。
- `verifier`：默认 `{"type":"basic"}`；用 `{"type":"llm"}` 开启端模独立调用自评。

配置相对路径相对于配置文件，不相对于当前 shell。认证环境变量只在模型调用时读取，不写入请求证据。

```sh
./scripts/trace-lab prepare --config /absolute/path/to/lab.json
./scripts/trace-lab replay --config /absolute/path/to/lab.json --sample all
./scripts/trace-lab evaluate --config /absolute/path/to/lab.json --run all
```

`prepare` 输出 sample ID 和合格性；也可以 `--sample <id>` / `--run <id>` 单独执行。
`replay` 遇到不合格样本跳过，执行失败或环境失配记录为 invalid，并返回非零退出码。
同样本重复重放创建新 run，不覆盖历史。重复 prepare 保留已有样本及人工标注；
需要更新采集快照时使用新的实验输出目录。首版按时间选择前 `maxSamples` 个 query，
不是主动学习采样算法；记录数超过 `maxRecords` 时明确拒绝，不静默漏掉部分 query。

## 上下文注入与工具执行

1. 将首个源 request 的 `system/messages/tools` 保存在 sample，不拼成一条新 user prompt。
2. 按 query 首次文件备份恢复工作目录；`absent` 保持不存在，只创建必要父目录。
   备份会复制到证据目录并记录 SHA-256，后续不依赖原数据目录。
3. 启动全新 Claude CLI，以临时 workspace 为 cwd；使用专用 `CLAUDE_CONFIG_DIR`、
   一次性代理密钥、`--bare --restricted`、文件工具白名单和无 MCP 设置，取消用户配置继承。
4. CLI 首次模型请求被代理拦截。对照实际工具 schema 后，发送源上下文前缀给端模。
5. 后续请求发送“源起点前缀 + 本次 CLI 新产生的 assistant / tool-result 后缀”。
   绝不注入源云端本轮后续回答或工具结果，不做 teacher-forcing 回放。
6. 模型返回工具调用时，将结构化 `file_path` 映射到 workspace，拒绝越界、符号链接和
   未捕获文件依赖，再交给 CLI 执行。不会全局替换代码或自然语言中的路径。
7. 记录 CLI 实际请求、注入后请求、端模原始响应和实际交给 CLI 的响应。

消息比对允许单个纯文本块与等价字符串互换、忽略 cache_control 元数据；不允许历史丢失、
压缩或内容改写。遇到这些情况中止并标为上下文问题。工具只保留双方兼容的文件工具子集，
源执行真正需要的工具缺失时中止。部分 CLI 不广告 Write，即使启动参数包含它，也不会伪造支持。

模型端离线使用完整 JSON 响应；代理合成 Anthropic SSE 供 CLI 消费，不模拟 token 级时序。
本地模型需要支持实际 function calling，仅能纯文本生成的服务不等于通过重放验收。

## 文件和重放有效性

所有执行均在 `runs/<run-id>/workspace`。源目录只用于定位映射，不在那里执行工具；
输出与源目录的重叠会在写入重放目录之前拒绝，包括符号链接别名。

备份只能恢复捕获过的文件，**不是原项目完整快照**。未捕获文件、目录和依赖不可自动补齐。
`valid=true` 仅表示模型可见前缀续接及已捕获文件范围内的受限执行有效，不证明恢复了
源 Harness 所有内部状态，也不证明整个原始环境完整。原始轨迹出现未支持工具或缺少快照时
保守排除。运行时缺失依赖、工具不兼容、权限拒绝、超时和前缀变化，都不能作为模型能力失败标签。

历史自然语言和代码中的旧绝对路径保留；新的文件工具参数会映射到独立目录。该映射、
受限工具集、新会话内部状态、输出预算都属于实验条件变化，记录在 run/call 中。
结果用于受限 MVP，不宣称与原环境严格等价。

## 极简 verifier 与扩展

`basic` 只检查 sample 的 `assertions`。在 replay 前编辑 `samples/<id>.json`，例如：

```json
{
  "assertions": [
    {"type":"file_contains", "path":"result.txt", "value":"expected text"},
    {"type":"answer_contains", "value":"完成"}
  ]
}
```

还支持 `file_equals` 和 `file_absent`。没有断言时返回 uncertain，不将“CLI 正常退出”当作正确。
assertions/context/files 在重放后改变，需要重新重放；`split` 是数据集标注，可在之后修改。

`llm` 对当前任务、历史、候选最终回答及有限文件预览进行独立评估，返回 pass / fail / uncertain。
使用与端模相同的目标配置，**属于 provisional 自评，不是客观正确性证明**。文件预览每项 4 KiB，
显式标记截断；整个评估输入超过 256 KiB 时返回 uncertain，不悄悄丢历史。模型输出不合法或
评估失败同样 uncertain。源云端回答不自动当成 gold answer。

外部插件示例：

```js
// my-verifier.mjs
export async function verify({sample, run}, config) {
  return {verdict: "uncertain", evidence: ["Replace with task-specific checks"]};
}
```

配置 `{"type":"module", "module":"./my-verifier.mjs"}`。插件是用户明确配置的本地 JS 代码，
与引擎同权限运行；输出协议固定为 verdict 和 evidence 数组，可以追加维度与原始评分。
内核先检查重放有效性，插件不能把 invalid run 覆盖成能力正例。插件文件哈希、配置哈希、
版本及运行来源随评估记录保存。

## 经验与策略包

原始证据位于 `evidence/`、`runs/`、`evaluations/`。`policies/` 是策略专属经验形态。
第一版使用无外部依赖的词项/中文二元组余弦检索，**不是 embedding 语义模型**。
正例相似度需超过阈值，并领先反例一定 margin；源工具配置也需匹配。特征仅取起点已知
的 user/assistant 文本，最多末尾 64K 字符；不使用本轮未来回答、评分和产物作检索输入。

将 samples 的 `split` 显式分配为 train / calibration / test；默认 unassigned，不自动混用。
同一源 conversation 不能跨 split。评估条件不变的 repeated run 标签冲突会中止构建。

```sh
./scripts/trace-lab build --config /absolute/path/to/lab.json
./scripts/trace-lab publish --config /absolute/path/to/lab.json --policy <policy-id>
```

build 只用 train 建案例索引，用 calibration 选阈值；test 不参与调参。
默认至少需要 train 正反例、calibration 正反例、2 个校准本地预测，且错误本地预测比例不超过 5%。
样本不足仍保存候选策略，但 validation 不通过，publish 会拒绝。小样本通过这个门槛不意味着
统计意义上的质量保证；仍需更大的独立交互测试。近重复场景划分需要人工检查。

provisional 自评默认不进入策略；实验需要时可在 policy 中设置 `allowProvisional: true`，
产物仍保留 provisional 标志。切换模型、deploymentId 或 Harness 配置会改变执行配置指纹。
构建还检查实际 Harness 版本与 verifier 一致性。

publish 写入 `releases/<id>/policy.json` 和原子更新的 `current-policy.json`。
**仅发布本地策略包，不会修改在线网关或自动激活流量路由。** 在线消费协议是后续集成点。

## 数据目录

```text
lab-data/
  samples/                 # 完整起点请求、依赖、合格性、split、验收条件
  evidence/<sample-id>/    # 源轨迹及原始文件副本
  runs/<run-id>/           # 独立工作目录、调用证据、CLI 输出、run.json
  evaluations/            # 插件结果与 provenance
  policies/               # 检索案例和校准结果
  releases/               # 发布版本
  current-policy.json
```

原始文件与模型上下文可能含私有内容。引擎不上传发布包；模型请求只发给用户配置的 endpoint。
文件不做文本脱敏以保留回放语义。首版不实现自动保留清理、自动 heartbeat 或在线策略加载。

## 验证

```sh
./runtime/node --test lab/test/*.test.mjs gateway/test/*.test.mjs
TRACE_LAB_CLAUDE_BIN=/opt/homebrew/bin/claude ./runtime/node --test --test-name-pattern='real Claude CLI' lab/test/lab.test.mjs
```

后一测试使用真实 CLI 与本地模拟模型，验证历史注入及 Read→Edit→最终回答，并检查源文件不变。
它验证执行通道，不代表真实端模任务质量；本轮未调用真实端模或云端模型。

## OpenAI source normalization

Chat Completions system/developer, user/assistant, function tool_calls and tool results are normalized to Messages. Tool IDs are preserved. read/write/edit map to Read/Write/Edit; sandbox_permissions and justification are execution metadata, removed from executable tool schemas. Original requests remain in originalRequest and evidence; initialRequest holds normalized history, with sourceProtocol and normalizationVersion recorded. String reasoning_content is preserved for OpenAI targets; Anthropic targets explicitly reject such history. Unsupported rich history, orphan results, pending historical calls, tool-name collisions and interleaved system messages are rejected.

Use a fresh outputDir after upgrading: existing samples are intentionally never overwritten by prepare. Responses API is not yet supported. File capture and tool isolation checks still apply independently.

## Restricted Python command replay (macOS)

Bash/bash is supported only for `python3 <captured-script.py>` with one path (optionally quoted). Flags, additional arguments, shell operators and a per-command workdir/cwd are rejected. The source script must have a saved/absent capture entry; the actual runtime script must exist as a regular file inside the workspace. Unsupported commands receive `unsupported_bash_command` rather than an unrelated file_path error.

The Lab replay proxy owns execution, not the CLI Bash tool. It maps the script path and invokes a fixed Python interpreter through macOS sandbox-exec, without a shell. The interpreter uses -I -B, a minimal environment without API keys, a 10-second timeout and a combined 64 KiB stdout/stderr limit. The profile denies network, process forks, writes outside the workspace and file content reads outside the workspace/system runtime allowlist. No unsandboxed fallback exists; non-macOS or unavailable sandboxes result in invalid runs. Isolated Python does not inherit user site packages or script-directory imports; missing dependencies require explicit future environment support.

Python is exposed as a virtual Bash tool with a restricted schema. Its assistant/tool-result exchange is injected into subsequent model calls in order and stored in call modelSteps, including stdout, stderr, exit status and runtime failures. It never executes original recorded commands automatically. Mixed Python/file-tool calls in one model response are rejected in this MVP. A nonzero Python exit, sandbox refusal, timeout or output overflow invalidates the run rather than producing a capability failure label.

## Pure text requests and auxiliary traffic

Queries whose source turn has no tool calls or captured file entries use `executionMode: "text-only"`. They can replay without a sourceRoot; Lab creates a fresh empty workspace and disables both CLI tools and model tools. Unexpected candidate tool calls invalidate the run. Requests with file/command dependencies still require a source root and captured dependencies.

Known title-generation and suggestion templates receive heuristic sampleKind labels (`auxiliary:title`, `auxiliary:suggestion`); the original query is retained. The UI displays these labels. Counts currently include auxiliary requests; the label does not certify arbitrary prompts as user-authored, nor does it automatically create training splits. Existing sample files remain unchanged; use a new outputDir when re-preparing.

## Anthropic thinking history

An Anthropic target accepts assistant history blocks of type thinking with string thinking/signature fields. The blocks and signatures are preserved verbatim in Messages requests and evidence; returned thinking blocks are forwarded to the CLI via thinking_delta/signature_delta SSE events. Missing signatures or unsupported content types remain explicit preflight failures. OpenAI targets reject Anthropic thinking history instead of dropping it; conversely, an Anthropic target rejects OpenAI reasoning_content history without attempting to invent a signature. Manual protocol mode keeps these restrictions; auto mode selects a native protocol per sample. Acceptance by a compatible service does not prove that its internal reasoning semantics match Anthropic.

## Automatic protocol selection

Set target.protocol to auto when one baseURL serves both /chat/completions and /messages for the same model. Selection is deterministic: Anthropic thinking history -> anthropic; OpenAI reasoning_content -> openai; otherwise retain sourceProtocol when recognized, or default to openai. Mixed incompatible reasoning representations are rejected. Manual openai/anthropic settings remain supported. There is no network fallback/retry to a different protocol.

prepare records targetProtocol per sample; replay pins the selected protocol for every model call and records it in run/call evidence. Config fingerprints include the auto selection version. The LLM verifier chooses independently from its actual input and records judgeProtocol. Original history, thinking text and signatures remain unchanged. Use a fresh outputDir to rebuild preflight results after changing protocol settings; historical results remain intact.
