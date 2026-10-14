; electron-builder 自动引入（buildResources/installer.nsh）。
;
; 卸载时把开机自启那一项一起删掉。值名是 AppUserModelId（main/index.ts 里的
; setAppUserModelId），不删的话注册表里留一条指向已删除 exe 的启动项，
; 安全软件会把它报成「无效 / 可疑启动项」。
; 升级时旧版本的卸载程序也会跑一遍，这时不能删 —— 用户的开关得原样留着。
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.unreal.agent"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.unreal.agent"
  ${endIf}
!macroend
