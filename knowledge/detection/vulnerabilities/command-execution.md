# 命令与进程参数完整性

源码出现 child_process 或包装器，且入参来自任务设置、请求或资源元数据。

## 安全属性与成立条件

执行的程序、允许的参数语义和运行环境应落在设计范围内。先明确代码是调用 shell、直接创建子进程、调用一个纯 JS 实现还是只拼接日志。非 shell API 也仍需约束参数的含义。

## 源码调查

阅读实际模块导入、进程包装器、程序位置、参数拼装、`shell` 配置和工作目录。查输入值来自可信映射、受校验请求还是任意外部元数据。判断校验是在调用前阻止不允许的值，还是仅生成日志或返回提示。Windows 与 POSIX 的脚本启动机制以目标 Node 版本的文档和配置为据。

## 证据、控制与反证

优先考虑库 API。确需进程时使用固定可执行文件、分离参数、无 shell 的适用调用方式和明确的允许参数。固定映射到预先定义的操作是有效对照，仍应确认参数和程序行为都在已认可范围。引用真正的启动点、参数来源、解释模式和控制。符号名为 exec 或命中通用进程规则只提供阅读位置。

## 进程接口的不同解释边界

Node.js `exec` 将命令文本交给 shell。`execFile` 默认直接启动文件，`spawn` 需检查 `shell` 选项以及调用的到底是程序还是解释器。Windows 批处理及启动方式遵循平台文档，不能把 Linux 进程路径当作所有部署的结论。即使没有 shell，实际程序可能把参数解释为选项、配置、脚本或路径。沿调用者和 adapter 追踪可执行文件、每个 argv 项、环境、工作目录以及程序所用输入文件的来源。若命令只可选择内部枚举，先确认映射由服务端拥有，并检查找不到映射时的分支。

Python `subprocess.run` 通常不隐式选择系统 shell，阅读调用是否传入参数序列、明确启用了 shell、或选择了 Windows 批处理文件。Windows 文档描述了批处理可能由操作系统经 shell 启动的例外。如果包装器先验证一个业务选项，再把整条用户输入交给执行层，追踪通过控制的是哪个值，实际进程消费的是哪个值。

~~~ts
const reportArgs = {
  summary: ['--mode', 'summary'],
  detail: ['--mode', 'detail'],
} as const;
function generateReport(mode: keyof typeof reportArgs) {
  return execFile('/opt/app/bin/report', [...reportArgs[mode]], {
    cwd: '/opt/app',
    shell: false,
  });
}
~~~

调用侧仍需运行时解析枚举。安装路径和工具写权限要由部署确定。进程规则常标记执行 API 作为审阅点。若日志只展示参数文本、实际子进程消费固定参数，这是相关反证。若值可进入 shell 命令或解释器指令，则要引用实际构建与执行分支，注明运行账户、程序行为存疑之处。仅知道启动程序，不能推出已执行任意代码。

## References

- [OWASP · OS Command Injection Defense](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.md)
- [Tencent SecGuide · JavaScript 安全指南](https://github.com/Tencent/secguide/blob/bfda087142e3bb3f5840cbc6af82c1982d1d14e4/JavaScript%E5%AE%89%E5%85%A8%E6%8C%87%E5%8D%97.md)
- [Semgrep · detect-child-process.yaml](https://github.com/semgrep/semgrep-rules/blob/a5ad1714f00c9f7fde980cab0ea1d6dc6d414fd2/javascript/lang/security/detect-child-process.yaml)
- [Node.js · Child process](https://nodejs.org/api/child_process.html)
- [Python · subprocess 安全语义](https://docs.python.org/3/library/subprocess.html#security-considerations)
- [版本、许可证及改写说明](../SOURCES.md)
