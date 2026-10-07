# 0.1.0 部署验证证据

验证日期：2026-10-07。依据 [Deployment.md](./Deployment.md)。
已验收实现 revision：f5988b5c1a8d24fa8fb876e53974d48315ba81ed。
发布准备交付物来自 primary ac108f7dd2d096d9a3d495296ec95bdf07f484ad；
随后仅增加 checklist 与 acceptInner 事件，不改变发布包。

## 发布授权与认证

用户在交互确认中明确授权公开发布 causal-weave@0.1.0、MIT、latest、
官方 npm registry。npm whoami 实测为 shazhou.ww。
自动上传因 EOTP 被拒绝，2FA 由用户自己的终端完成；
没有获取、保存或提交密码、token 或一次性验证码。

用户先发布了占位版本 0.0.0-stage，随后上传准确 0.1.0 包。
曾出现版本不存在 / latest 指向占位包的观察，故没有提前宣告部署成功。
再次上传显示不能覆盖已发布的 0.1.0 后，改为查询并核验，
没有更改版本号、unpublish、覆盖或盲目重发。

## Registry 结果

执行：

```sh
npm view causal-weave@0.1.0 name version license dist.integrity dist.shasum dist.tarball --json --registry=https://registry.npmjs.org --prefer-online
npm view causal-weave dist-tags versions --json --registry=https://registry.npmjs.org --prefer-online
```

实际结果：

```json
{
  "name": "causal-weave",
  "version": "0.1.0",
  "license": "MIT",
  "dist.integrity": "sha512-BOZuM2EmD0ANp0tV5YBvFLlywNqvNt/Cmb9zUda+A7sBNwvW2jac8B6PJWk7nznyID2vTzye5VbvyKKRXkandg==",
  "dist.shasum": "e8e4c7ce2114fb96ab4c36229dca7d9cb81becf2",
  "dist.tarball": "https://registry.npmjs.org/causal-weave/-/causal-weave-0.1.0.tgz",
  "dist-tags": { "latest": "0.1.0" },
  "versions": ["0.0.0-stage", "0.1.0"]
}
```

integrity 和 shasum 与实施阶段独立核验 tarball 完全一致，
不是只校验版本文字或上传命令成功提示。
公开包入口：https://www.npmjs.com/package/causal-weave/v/0.1.0。
占位版本保留，不作为本次验收交付物。

## 独立 Registry 安装与消费

在仓库外的全新临时目录建立私有 ESM 消费项目，执行：

```sh
npm install causal-weave@0.1.0 --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund --prefer-online
node smoke.mjs
tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 types.mts
npm ls --omit=dev
```

安装源为 registry 版本，不是本地目录或 tarball。
package-lock 中 resolved 为上述官方 tarball URL，integrity 与验收包相同。
运行时依赖树仅包含 causal-weave@0.1.0；没有 Silvermoon / TypeScript 运行时依赖。
类型验证使用已有本机 TypeScript 编译器，
模块解析使用独立消费项目中已安装的包，不引用 src 或仓库 dist。

实际 smoke 断言均通过：

1. 从已安装包的 ESM exports 导入 Channel 与 ID / Frontier 创建辅助函数。
2. 使用消费者提供的最小内存策略，A 发送第一条，B 引用 A 后发送第二条。
3. 两页 limit=1 读取保持正确顺序、hasMore 和累计 nextFrontier。
4. 精确重投 A 保留 sequence=1，登记条数仍为 2。
5. getState 返回两端正确前沿。
6. watch 异步初始通知一次，重复取消安全且移除订阅。
7. 安装后 manifest 为 version=0.1.0、license=MIT，无 dependencies。
8. 安装包包含 MIT LICENSE。
9. 声明支持合法 Message / Result 消费，并拒绝缺少 contentType 的发送请求。

Node.js v24.12.0；TypeScript 5.9.3。
未声称本次重新验证所有浏览器、数据库或分布式存储；
此前实现阶段的 Chromium smoke 证据保持在 Inner World。
消费者内存策略只用于安装验证，没有作为生产 adapter 发布。
临时消费目录验证后清理，认证配置未进入该目录或仓库。

## 验收边界

npm 公开发布与 registry 消费验证完成，等待准确 deploymentRevision 的 acceptOuter。
没有自动替用户作出部署验收，也没有修改 Silvermoon 业务仓库。
