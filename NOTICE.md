# Notice

win-dori is a modified version of [dori-superagent](https://github.com/sisyphuslabs/dori-superagent) by Sisyphus Labs (YeonGyu Kim), distributed under the Sustainable Use License in [LICENSE](LICENSE). As that licence requires, this notice states that the software has been modified.

What was modified: win-dori ports dori-superagent to Windows and changes only what Windows needs: path handling and shell quoting for pwsh, Windows PowerShell 5.1, cmd and Git Bash; spawning `.cmd` shims; retries on Windows file locks; reading the Windows process table and load; herdr and hc (herdr-core) process handling on Windows (herdr-core #70); monitors that exit with their shell on Windows; a Windows profile (`profile/`: Task Scheduler autostart and a boot script); `install.ps1`; and Windows jobs in CI. Each upstream change is ported with only what Windows needs changed; the pull requests of this repository list every port and every Windows change.

Licence history: revisions of win-dori up to and including fa86ddf were distributed under the MIT License, like the upstream revisions they were based on, and stay MIT for those revisions. From the port of upstream 7ac0ed7 on, win-dori is distributed under the Sustainable Use License, as upstream is: use, modification and distribution are limited to personal, internal business and free non-commercial purposes.
