#!/bin/bash
set -e

# bash 入口，供 Linux / 服务器 / 装了 node 的 WSL 使用。
#
# **本仓库的规范入口是 `npm run verify`**，两边跑的是同一批脚本。
# 本机（Windows + PowerShell，WSL 内没有 node/npm）跑本脚本会 exit 127
# ——「npm: command not found」。所以代理在本机一律用 npm run verify，
# 别把本脚本写进启动工作流当默认动作。
#
# ⚠️ 命令要写成「npm run」后面紧跟脚本名，中间不要插 --silent：
#    插了之后 harness 审计的校验器会把 --silent 当成脚本名，于是
#    「文档里的命令能解析」这条判据判成 DANGLING（实测 5 resolved / 2 dangling）。

cd "$(dirname "$0")"

RAN=0
step() {
  RAN=$((RAN + 1))
  echo ""
  echo "--- [$RAN] $* ---"
}

echo "=== 两年了 · 验证 ==="

step "语法检查：每个 .js/.mjs 都要能解析，部署文件行尾为 LF"
npm run check

step "全量测试"
npm test

step "依赖就位 + 服务可启动 + 时间锁闸门"
npm run boot

if [ "$RAN" -eq 0 ]; then
  echo ""
  echo "ERROR: 一步都没跑。门禁不能失败就不是门禁。"
  exit 1
fi

echo ""
echo "=== 验证通过（$RAN 步）==="
echo "提交前把命令与结果摘要记入当前工单。"
