@echo off
rem uebox -- UE Box command line.
rem
rem ASCII ONLY. cmd.exe reads .cmd files in the OEM code page (GBK on zh-CN
rem machines), so UTF-8 Chinese comments here get mis-decoded and corrupt the
rem parsing -- including the `set` line below. Verified the hard way: the first
rem version of this file had Chinese comments and every invocation died with
rem "Cannot find module '...\=1'". Keep the explanation in Chinese in
rem scripts/build-cli-bundle.mjs, not in here.
rem
rem No Node.js required: the box ships Electron, which contains a full Node
rem runtime. With ELECTRON_RUN_AS_NODE=1 the app exe behaves as node.
rem
rem This file sits next to the exe (electron-builder `win.extraFiles`),
rem so %~dp0 is the install directory.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0unreal-agent.exe" "%~dp0resources\cli\index.js" %*
rem Exit code must pass through unchanged -- callers (scripts, agents) rely on
rem it to tell config errors from ambiguous projects from engine failures.
exit /b %ERRORLEVEL%
