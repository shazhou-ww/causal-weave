# Deployment

## 目标与授权边界

准备首次公开发布 causal-weave@0.1.0 到 https://registry.npmjs.org，
使用 MIT 许可证。用户已授权准备版本和发布配置，
但实际上传 npm 前仍需明确确认，不把部署验收当作发布授权。

当前 npm whoami 返回 E401，用户须在自己的终端执行
`npm login --registry=https://registry.npmjs.org` 并完成浏览器 / 2FA。
不收集、不记录或提交密码、token、OTP 或 npm 本地认证配置。
包名查询返回 404，仅说明当前无可见包，不保证名称一定可注册。

版本、许可证和发布配置改变了实现交付物，应先对新的
implementationRevision 完成复核 / acceptInner，不能沿用原版本的验收。
不修改 Silvermoon 仓库，不自动为 Silvermoon 安装本包。

## Steps

### D-S01: 确认发布前提与登录

新的实现候选验收后，确认 npm 发布身份与名称权限，
将本部署契约同步到 primary，重新观察精确 deploymentRevision。
登录由用户完成；whoami 成功仅证明身份，不证明所有发布权限。

### D-S02: 确认并上传准确发布包

用户明确授权实际上传后，构建并使用已验证的 tarball 发布 0.1.0，
public access、latest tag、官方 registry。包内容与实现验收候选对应。
遇到 2FA 由用户自行完成，不绕过认证。
上传结果不确定时先查询 registry，不盲目再次上传。

### D-S03: 从 registry 验证消费结果

核对已发布版本、dist-tag、许可证与 tarball integrity；
在独立目录从 registry 安装准确版本，验证 ESM、类型与 send/read 使用。
记录部署证据并保持 ledger 镜像，等待用户 acceptOuter。

## Acceptance criteria

### D-AC01: 发布前提明确

npm whoami 成功；新的实现候选已验收；发布命令有用户明确授权；
检查过程不泄露凭据，名称、版本、访问与 registry 都明确。

### D-AC02: 准确版本可从 registry 获取

npm registry 显示 causal-weave@0.1.0、MIT、latest；
上传 tarball 与核验候选一致，保存公开 integrity 等证据，不保存认证信息。

### D-AC03: 外部安装与公共 API 正常

仓库外消费者从 registry 安装 0.1.0 后，
ESM 导入、类型检查、因果发送及 Frontier 分页成功；
不依赖 Silvermoon 或仓库内路径，无运行时依赖。
