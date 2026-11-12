@echo off
rem SynapseHub 源码启动器（仅开发/源码运行用；打包后的 exe 不需要）
rem
rem 为什么需要这个文件：
rem   某些环境（含 WorkBuddy/VS Code 的集成终端、部分 Electron 工具链）会导出
rem   ELECTRON_RUN_AS_NODE=1，让 electron.exe 以 Node 模式启动 —— 表现为不弹窗口、
rem   或直接崩在 `ipcMain is undefined`。注意把它设成**空字符串也没用**：
rem   Electron 底层用 getenv() 判断，只要变量存在就生效，必须真正删掉这个变量。
rem
rem 用法：双击本文件，或在命令行执行 start.cmd

setlocal
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE=1"

cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [错误] 找不到 Electron，请先在当前目录执行：npm install
  echo        如果卡在下载，用镜像：
  echo        set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  pause
  exit /b 1
)

echo 启动 SynapseHub...
"node_modules\electron\dist\electron.exe" .
if errorlevel 1 pause
