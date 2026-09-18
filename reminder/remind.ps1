# Reminder shown by a one-shot Windows scheduled task.
#
# Deliberately self-contained: it reads nothing, calls nothing, and depends on
# no other process being alive. If the desktop session is not interactive the
# dialog cannot appear, so the text is also written next to this file — a
# reminder that silently does nothing is worse than no reminder.

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
$text = @"
dsh-subscription-login 可以提 PR 了

仓库满 1 天的门槛（2026-09-19 22:05）已经过了。

要做的：
  1. 建一个 GitHub PAT（只勾 public_repo，7 天有效期）
     https://github.com/settings/tokens/new
  2. 粘进这个文件：
     H:\dzjpmjdjb\dsh-subscription-login\.secrets\github-token.txt
  3. 回 DSH 里说一声，PR 由我来提

条目文件已经写好了，完整清单见：
  H:\dzjpmjdjb\dsh-subscription-login\PUBLISHING.zh.md

提醒时间：$stamp
"@

# Always leave a durable trace first.
$log = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'reminded.txt'
"REMINDER SHOWN at $stamp" | Out-File -FilePath $log -Encoding utf8 -Append

# Then try to actually interrupt the human. Record which path was taken, so a
# reminder that never reached a screen is visible afterwards instead of looking
# like success.
try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $shown = [System.Windows.Forms.MessageBox]::Show(
        $text,
        'DSH 插件上架提醒',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
    )
    "  dialog dismissed: $shown" | Out-File -FilePath $log -Encoding utf8 -Append
} catch {
    "  dialog FAILED: $($_.Exception.Message)" | Out-File -FilePath $log -Encoding utf8 -Append
    # No interactive desktop after all: fall back to something unmissable.
    try {
        $txt = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'REMINDER.txt'
        $text | Out-File -FilePath $txt -Encoding utf8
        Start-Process notepad.exe -ArgumentList $txt
        "  fell back to notepad" | Out-File -FilePath $log -Encoding utf8 -Append
    } catch { }
}
