<p align="center">
  <img src="skills/dori-mode/assets/dori-avatar.png" alt="Dori" width="120">
</p>

# win-dori

이미 쓰는 채팅 안에 있는, 24시간 일하는 엔지니어.

[English](README.md) | [简体中文](README.zh.md) | [Deutsch](README.de.md) | [日本語](README.ja.md) | [Italiano](README.it.md) | 한국어

[![CI](https://github.com/useonmn/win-dori/actions/workflows/ci.yml/badge.svg)](https://github.com/useonmn/win-dori/actions/workflows/ci.yml)
[![License: SUL-1.0](https://img.shields.io/badge/license-SUL--1.0-blue.svg)](LICENSE)

> **win-dori는 [sisyphuslabs/dori-superagent](https://github.com/sisyphuslabs/dori-superagent)의 Windows 포트입니다.** Dori와 dori-superagent는 Sisyphus Labs의 프로젝트이고, win-dori는 업스트림 커밋 [97d807b](https://github.com/sisyphuslabs/dori-superagent/commit/97d807b9037cb050a72129659cf6306d8055010d)을 따르며 업스트림의 동작과 기본값을 그대로 둡니다. 더한 것은 Windows에 필요한 것뿐입니다. PowerShell 설치, 셸을 가려 쓰는 pane, 자동 시작과 Slack 리스너가 들어 있는 Windows 프로필입니다. Dori의 공은 업스트림 저자들에게 있고, Windows 부분의 버그는 저희 몫입니다. 업스트림 이슈는 [sisyphuslabs/dori-superagent/issues](https://github.com/sisyphuslabs/dori-superagent/issues)에 올려 주세요.

> **라이선스.** 이번 포트부터 win-dori는 업스트림과 같이 [Sustainable Use License](LICENSE)를 따릅니다. 개인 사용, 사내 업무용 사용, 무료 비상업적 사용만 허용됩니다. win-dori가 무엇을 바꿨는지는 [NOTICE.md](NOTICE.md)에 있습니다. `fa86ddf`까지의 버전은 MIT였고 그대로 MIT입니다.

Dori는 여러분의 Slack, Discord, Telegram에 삽니다. 스레드에 할 일을 적으면 그 일에 전용 코딩 에이전트 세션을 붙이고, 일이 끝났다는 게 증명되면 답장합니다. 머지된 PR, 닫힌 이슈, 배포된 버전 같은 것이 증명입니다. 요청이 없는 동안에는 다음 할 일을 스스로 찾습니다. 설정은 이게 전부입니다.

이 저장소 `dori-superagent`는 Sustainable Use License로 공개된 Dori입니다. Dori mode(`skills/dori-mode`)는 여러분이 말을 거는 봇입니다. 코딩 에이전트용 스킬과 `dori` CLI로 이뤄져 있고, CLI는 일하는 세션을 열고 추적하고 닫으며 Slack, Discord, Telegram과 통신합니다.

하네스(`src/`)는 그 뒤의 기계실입니다. 리드 세션 하나, 당직 루프, 매시 루프, 호스트가 버티는 만큼의 레인, 그리고 머지 게이트로 이뤄져 있고, 런타임 의존성 없이 [Bun](https://bun.sh) 위에서 TypeScript 약 4,600줄로 돌아갑니다. 세션이 사는 터미널 런타임 [herdr](https://github.com/herdrdev/herdr)(또는 같은 프로젝트의 헤드리스 런타임인 hc, herdr-core)와 GitHub 스타 70.8k개의 코딩 에이전트 [omo](https://github.com/code-yeongyu/oh-my-openagent) 위에서 동작합니다.

## 얻는 것

- 스레드에 글을 쓰면 Dori가 메시지에 "eyes" 리액션을 달고 1분 안에 답합니다. 작업이 도는 동안 상태는 메시지 하나로 남고, Dori가 그 메시지를 그 자리에서 고칩니다. 15분마다, 그리고 마일스톤마다 짧은 진행 메모가 붙습니다.
- 작업마다 herdr 탭이 따로 열리고, 시작부터 종료까지 레지스트리에 기록되며, 호스트가 버티는 만큼 동시에 돕니다. 메모리, 디스크, 페인 수가 선을 넘으면 호스트 가드가 새 실행을 붙잡아 둡니다.
- 증거 없는 "완료"는 없습니다. 레인은 증거와 함께 완료를 주장하고, 그 주장은 실제 상태와 대조됩니다. PR이 머지됐는지, 이슈가 닫혔는지, 그 버전이 npm에 있는지, 명령이 통과하는지, URL이 응답하는지 확인합니다. 맞지 않는 주장은 5분 안에 미완료로 돌아가고, 푸시하지 않은 작업이 남은 레인은 닫히지 않습니다.
- 알림은 머지 때만 옵니다. 여러분과 말하는 세션은 리드 하나뿐이고, 코드 변경은 머지가 끝난 뒤 PR과 머지 커밋과 함께 보고합니다. 레인과 당직 루프는 여러분에게 말을 걸지 않습니다.
- 자리를 비워도 일은 계속됩니다. 브리프는 백로그에서 기다립니다. 매시간 루프가 끝난 항목을 정리하고, 아무도 닫지 않은 항목을 점검하고, 결정이 필요 없는 다음 항목을 시작하고, 열린 질문은 한 번씩만 묻습니다.
- 작업마다 스레드나 Telegram 토픽이 따로 생기고, 이름에 상태(`[working]`, `[waiting]`, `[done]`)가 붙습니다. 끝나면 보관되고, 다시 글을 쓰면 다시 열립니다.
- 음성 메시지는 여러분이 정한 음성 인식 명령으로 받아 적어 글처럼 처리합니다.
- 재시작해도 잃는 게 없습니다. 요청 작업 기록, 레인별 체크포인트, 레지스트리가 디스크에 있고, `dori boot`가 그것을 읽은 뒤에야 Dori가 자기 기억을 믿습니다.
- 스레드의 언어로 답하고, 여러분의 말투에 맞추고, 메시지를 짧게 쓰며, 이모지는 쓰지 않습니다.

## Dori가 사는 곳

Slack, Discord, Telegram은 `skills/dori-mode/scripts/src/messenger/`에 구현돼 있습니다. 아래 표는 지금 각 메신저에서 되는 일입니다. 표에 없는 일은 코드도 하지 않습니다.

| | Slack | Discord | Telegram |
|---|---|---|---|
| 게시와 제자리 수정 | 됩니다. 스레드 답장도 됩니다 | 됩니다. 본문의 멘션은 아무도 호출하지 않습니다 | 됩니다. 일반 텍스트나 표를 포함한 HTML |
| 스레드 | Slack 스레드 | 스레드 시작, 이름 변경, 보관 | 포럼 토픽: 생성, 이름 변경, 닫기, 다시 열기 |
| 입력 중 표시와 스트리밍 | | 입력 중 표시 | 입력 중 표시, 그리고 "Thinking…"으로 시작해 답이 써지는 동안 자라는 초안 |
| 인바운드, 메시지가 들어오는 길 | `dori inbound slack`: Threads 보기, Dori가 글을 쓴 모든 스레드(태그 여부와 무관), 읽지 않은 DM, 그룹 DM, 멘션 | 메신저 도구의 watch | `dori inbound telegram`: 소유자 메시지만 통과시키는 롱 폴. DM과 그룹 하나(`DORI_TELEGRAM_TOPIC_ID`가 있으면 그 안의 토픽 하나), 수정 포함, 미디어는 파일 id로 |
| 접속 표시 | `dori presence slack`이 멤버 계정을 온라인으로 유지 | `dori presence discord`가 게이트웨이에 온라인으로 접속 | |
| 파일 | 라이브러리에서 업로드 | | 인바운드 미디어의 파일 id |
| 토큰 | `DORI_SLACK_TOKEN`, 사용자 토큰이면 `DORI_SLACK_COOKIE`도 | `DORI_DISCORD_TOKEN` | `DORI_TELEGRAM_TOKEN`, `DORI_TELEGRAM_OWNER_ID`, 선택으로 `DORI_TELEGRAM_GROUP_ID`와 `DORI_TELEGRAM_TOPIC_ID` |

Slack에서는 Dori가 어떻게 보일지 설정할 때 고릅니다. 사용자 토큰이면 진짜 멤버입니다. 유료 좌석을 쓰고, 그 멤버가 보는 것을 다 보며, 초록색 온라인 점을 유지할 수 있습니다. 봇 토큰이면 앱입니다. 좌석이 필요 없고, 초대받은 채널만 보며, 여러분이 준 스코프 안에서만 움직입니다.

봇을 만들고 로그인을 마치는 일은 [agent-messenger](https://github.com/agent-messenger/agent-messenger)를 거칩니다. 표의 헬퍼들은 각 플랫폼 API를 직접 부르고, 속도 제한에 걸리면 서버가 알려 준 시간만큼 기다렸다 다시 시도하며, `$(`가 들어간 텍스트는 거부합니다. 메시지 텍스트는 데이터이고 셸을 거치지 않기 때문입니다. 어느 플랫폼에서든 `dori transcribe`가 `hooks.transcribe`로 설정한 명령으로 음성 메모를 텍스트로 바꿉니다. Teams, WhatsApp, LINE, WeChat, iMessage, KakaoTalk, Lark는 이 저장소에서 지원하지 않고, `dori send`는 모르는 채널을 거부합니다.

`dori send <slack|telegram|discord> --to TARGET --text TEXT [--thread ID] [--edit ID]`는 셸에서 메시지를 올리거나 고칩니다. 같은 클래스(`Slack`, `Discord`, `Telegram`)는 HTTP 클라이언트와 시계를 인자로 받는 모듈로도 가져다 쓸 수 있고(입력 중 표시와 접속 표시 헬퍼는 타이머를 받습니다), 테스트가 네트워크 없이 도는 것도 그 덕분입니다.

## 빠른 시작

여기에는 프로그램이 둘 들어 있습니다. 하네스는 win-dori에서 `dori-harness`이고(업스트림은 `dori`라고 부릅니다), Dori mode의 메신저 CLI가 `dori`라서 한 머신에 둘 다 둘 수 있습니다. 업스트림 글에 `dori up`이나 `dori merge`가 나오는 곳에서 win-dori는 `dori-harness up`, `dori-harness merge`를 씁니다.

### Windows

PowerShell에서, 어느 폴더에서든:

```powershell
irm https://raw.githubusercontent.com/useonmn/win-dori/main/install.ps1 | iex
```

체크아웃이 있다면 cmd.exe에서 `install.cmd`를 실행해도 됩니다. 같은 인자로 `install.ps1`을 부릅니다.

설치는 이 한 줄이 전부입니다. git이 필요하고(없는데 winget이 있으면 `Git.Git`을 설치합니다), bun과 herdr가 없으면 공식 설치 프로그램으로 설치합니다(`DORI_NO_DEPS=1`로 끕니다). 설치 위치는 `%USERPROFILE%\.dori\src`이고, 다시 실행하면 그 사본을 업데이트합니다(`DORI_NO_PULL=1`이면 pull을 건너뜁니다). 스킬은 `%USERPROFILE%\.agents\skills\dori-mode`에 디렉터리 정션으로 연결되므로 관리자 권한도 개발자 모드도 필요 없습니다. `bun install`과 `bun link`를 실행하고 bun의 전역 bin 폴더를 사용자 PATH에 더합니다. 그다음 `profile/`의 Windows 프로필을 배치합니다. `DORI_SKIP_PROFILE=1`이면 이를 건너뛰고 예시 설정을 `%USERPROFILE%\.dori\config.json`에 복사합니다. `DORI_SRC`, `SKILLS_DIR`, `DORI_HOME`으로 위치를 바꾸고, `DORI_REPO`로 포크를 지정합니다. PATH 변경이 반영되도록 끝나면 새 터미널을 여세요.

그다음 herdr를 열고 그 안에서 omo를 시작해 "Dori mode"라고 말하면 됩니다.

### Windows 프로필

프로필은 어떤 메신저를 고르든 재부팅 뒤에도 Dori가 계속 돌게 해 줍니다. 부트 스크립트, 설정, 자동 시작 작업, 그리고 Slack이라면 채널 규칙과 앱 매니페스트가 딸린 Socket Mode 인바운드 리스너가 들어 있습니다. 사용자나 폴더, 채널 이름은 어디에도 없습니다. 경로는 모두 `%USERPROFILE%`에서, id는 모두 당신의 토큰에서 나옵니다.

처음 "Dori mode"라고 말하면 Dori가 대화로 스스로 설정합니다. 메신저를 묻고, 당신만 읽을 수 있는 메모장 파일을 열어 토큰을 받습니다(토큰을 채팅에 붙여 넣지 마세요). `dori setup <messenger>`가 토큰을 확인하고, 알아낼 수 있는 id를 채우고, 당신의 Windows 사용자만 읽을 수 있는 `%USERPROFILE%\.dori\<messenger>.env`(`slack.env`, `telegram.env`, `discord.env`)를 저장한 뒤 `Dori Autostart` 작업을 등록합니다. 그 뒤로는 로그온하면 herdr가 뜨고, Dori 이름을 딴 워크스페이스가 열리고, 거기서 에이전트가 시작됩니다.

Slack 리스너는 집어 든 메시지마다 눈 리액션을 달고 스레드에 작업 중 상태를 띄우며, Dori가 답하면 눈을 체크 표시로 바꿉니다.

프로필 단계는 다시 실행해도 안전합니다. 직접 고친 파일은 그대로 두고 차이를 보여 주며, `config.json`은 만들기만 하고 바꾸지 않습니다. `DORI_DRY_RUN=1`은 미리 보기, `DORI_FORCE=1`은 고친 파일을 덮어쓰고 `.bak-<time>` 사본을 남기며, `DORI_NO_TASK=1`은 작업을 등록하지 않습니다. 실행할 때마다 되돌리는 스크립트 `%USERPROFILE%\.dori\undo-profile-<time>.ps1`이 생깁니다. 구성 요소 목록은 [profile/INVENTORY.md](profile/INVENTORY.md)에 있고, 체크아웃에서 `profile\install-profile.ps1 -DryRun`으로 프로필 단계만 돌릴 수 있습니다.

### Dori mode, 말을 거는 봇

herdr, Bun 1.4.4 이상, git, GitHub CLI `gh`가 필요합니다.

```sh
curl -fsSL https://raw.githubusercontent.com/useonmn/win-dori/main/install.sh | bash
```

이 명령은 저장소를 `~/.dori/src`에 클론하고, 스킬을 `~/.agents/skills/dori-mode`에 링크하고, `dori`를 PATH에 링크하고, 예시 설정을 `~/.dori/config.json`에 복사합니다. 적어도 `leadPane`(`herdr pane current`로 얻는 여러분의 herdr 페인), `laneWorkspace`, `defaultCwd`는 고쳐 주세요.

그다음 herdr 안에서 코딩 에이전트를 켜고 "Dori mode"라고 말하세요. 이름을 뭐로 할지(그냥 Dori, 또는 여럿을 나란히 돌리려면 ShipDori, WorkDori), 어떤 메신저를 쓸지 묻고, 봇 생성과 로그인을 여러분과 함께 마친 뒤 봇으로 인사합니다. 여러분의 것을 읽기 전에는 도구마다 허락을 구하고, 이 온보딩은 읽기만 합니다.

운영 계약은 [`skills/dori-mode/SKILL.md`](skills/dori-mode/SKILL.md)에 있고, 설정, 세션, 완료 프로토콜, 모든 명령은 그 [`references/`](skills/dori-mode/references/)에 있습니다.

### 하네스

Bun 1.4.4 이상, herdr, omo, `gh`(PR head SHA, 체크, 머지용)가 필요합니다.

```sh
git clone https://github.com/useonmn/win-dori
cd win-dori
bun install
bun link   # puts `dori-harness` on your PATH
```

herdr를 켠 다음:

```sh
dori-harness up
# UP runtime=herdr lead=w1:p1 duty=w1:p2 loop=w1:p3 hourly=w1:p4 home=~/.dori
```

그러면 `dori`라는 herdr 워크스페이스가 열리고, 리드 페인(시스템 프롬프트에 `prompts/lead.md`를 덧붙인 omo), 당직 페인(`prompts/duty.md`를 덧붙인 omo), 그 아래 당직 루프, 다시 그 아래 매시 루프가 생깁니다. 리드 페인에 말하세요. 리드가 브리프(목표, 입력, 산출물, 멈출 조건, 제약. [`examples/brief.md`](examples/brief.md) 참고)를 쓰고 레인을 직접 엽니다. 셸에서 같은 일을 할 수도 있습니다.

```sh
dori-harness start fix-flaky-login --brief examples/brief.md
# STARTED fix-flaky-login pane=w1:p5 brief=~/.dori/briefs/fix-flaky-login.md
dori-harness status
```

레인 안에서 omo는 레인 규칙이 건네준 명령으로 보고하고 끝냅니다.

```sh
dori-harness report fix-flaky-login --text 'reproduced: 1 failure in 20 runs, shared session fixture'
dori-harness report fix-flaky-login --status waiting --text 'WAITING: checks on owner/repo#12'
dori-harness ready fix-flaky-login --text 'root cause fixed in owner/repo#12, checks green' --evidence https://github.com/owner/repo/pull/12
```

`[READY fix-flaky-login]`을 받은 리드는 이렇게 합니다.

```sh
dori-harness review owner/repo#12            # fresh omo reviewer pinned to the head SHA; writes a receipt; exit 0 on CLEAR
dori-harness merge owner/repo#12 --dry-run   # MERGE_OK ... (dry run), or MERGE_REFUSED <why> with exit 2
dori-harness merge owner/repo#12             # gh pr merge --squash --match-head-commit <sha>
dori-harness done fix-flaky-login            # closes the lane's pane; only a READY lane can be closed
```

`bun src/cli.ts`를 인자 없이 실행하면 모든 명령과 플래그가 나옵니다.


### Windows 참고

- 토큰은 사용자 환경 변수가 아니라 `~/.dori/<messenger>.env`에 둡니다. `dori`가 그 파일(또는 `DORI_ENV_FILE`의 파일)을 직접 읽습니다. 한 번만 쓰는 셸이라면 `$env:DORI_SLACK_TOKEN = "xoxp-..."`로 설정하세요.
- 하네스는 pane에 명령을 입력하므로 pane마다 셸을 알아보고 거기에 맞게 따옴표를 붙입니다. pwsh, Windows PowerShell 5.1, cmd, Git Bash입니다. `DORI_PANE_SHELL`(`posix`, `pwsh`, `powershell`, `cmd`)로 덮어씁니다.
- 호스트 가드는 `powershell.exe` 호출 한 번으로 부하, 메모리, 스왑, 디스크를 읽습니다. 부하는 CPU 사용률 곱하기 CPU 수에 프로세서 큐를 더한 값이라 Unix의 1분 평균보다 더 출렁입니다.
- `Done =` 명령은 `["bun","test"]` 같은 argv 목록이라 같은 줄이 Windows, macOS, Linux에서 다 통합니다.

## 하네스는 어떻게 돌아가나

![architecture](docs/architecture.png)

역할은 셋이고, 각각 herdr 페인 안의 omo 세션입니다. herdr는 워크스페이스, 탭, 페인을 제공하고, 페인 안의 omo를 에이전트로 알아보며, 그 상태(idle, working, blocked, done)를 CLI로 알려 줍니다. dori는 페인에 무엇이든 하기 전에 그 상태부터 읽습니다.

리드는 여러분과 말하는 유일한 세션입니다. 요청을 브리프로 바꾸고, `dori-harness start`로 레인을 열고, 레인이 보내온 것을 읽고, 머지합니다.

레인은 자기 herdr 탭 안의 omo 세션 하나로, 브리프 하나에 레인 규칙(`prompts/lane-footer.md`)을 덧붙여 시작합니다. 마일스톤은 `dori-harness report`로 보고하고, 끝은 `dori-harness ready`로 냅니다. 이 명령은 증거 링크 없이는 보내지 않습니다.

당직 루프는 `dori-harness duty --interval 60`이고, 당직 omo 세션 옆 페인에서 도는 평범한 프로세스입니다. 틱마다 쉬게 된 페인에 대기 메시지를 밀어 넣고, 조용한 레인을 찌르고, 리드에게 에스컬레이션하고, 페인이 사라진 레인을 lost로 표시합니다. `dori-harness duty stop --text 'why'`가 비상 정지 스위치이고, `dori-harness duty resume` 전까지는 틱마다 멈춘 이유만 출력합니다.

매시 루프는 `dori-harness loop`이고, `dori-harness up`이 네 번째 페인에서 시작합니다. 일은 `~/.dori/backlog/` 아래 백로그에서 항목당 브리프 하나로 기다립니다. 리드가 넣거나, 라벨이 붙은 GitHub 이슈에서 가져옵니다.

```sh
dori-harness backlog add search-index --brief briefs/search.md --priority 2
dori-harness backlog add new-billing --brief briefs/billing.md --decision 'charge per seat or per workspace?'
dori-harness backlog import owner/repo --label dori     # label p1..p9 sets the priority, needs-decision marks a question
```

게이트(멈추지 않았을 것, 다른 루프가 잠그지 않았을 것, 지난 실행 뒤 한 주기 이상 지났을 것)를 통과한 실행은 먼저 항목을 레인과 PR 상태에 맞춥니다. 다음으로 놓친 일을 점검합니다. 3시간 조용한 레인, 2시간 동안 아무도 닫지 않은 READY 레인, 사라진 페인입니다. 그다음 호스트의 부하와 메모리에 여유가 있는 동안 열린 레인 `--max-lanes`(기본 3)개, 실행당 `--max-starts`(기본 2)개 안에서 다음 항목을 가져옵니다. 열린 질문은 `[DECIDE <id>]`로 리드에게 한 번 가고, 6시간 뒤 한 번 더 상기시킵니다. 실행은 리드에게 보내는 `[LOOP ...]` 보고 하나로 끝납니다.

루프는 레인을 열고 메시지를 보낼 뿐, 머지하거나 푸시하거나 페인을 닫지 않습니다. 전체 설계는 [`docs/hourly-loop.md`](docs/hourly-loop.md)에 있습니다.

![lane lifecycle](docs/lane-flow.png)

`dori-harness start <key> --brief FILE`은 브리프와 레인 규칙을 `~/.dori/briefs/<key>.md`에 쓰고, 탭을 열고, 그 브리프를 가리키는 프롬프트로 omo를 실행하고, 레인을 `working`으로 기록하고, 리드에게 `[START <key>]`를 보냅니다. 그 뒤로 레인은 보고하고(`[REPORT <key>]`, 자기 페인 밖의 일로 막히면 `[REPORT <key> WAITING]`) 증거 링크와 함께 `[READY <key>]`로 끝냅니다. 계속 쉬고 있는 레인은 10분과 20분에 찔리고, 40분에 리드에게 에스컬레이션됩니다. READY 전에 페인이 사라진 레인은 `[LOST <key>]`로 보고됩니다.

상태는 `~/.dori`(또는 `$DORI_HOME`) 아래 디스크의 JSON입니다. `lanes/`, `inbox/`, `briefs/`, `receipts/`, 그리고 매시 루프용 `backlog/`와 `loop/`, 당직 루프의 정지 파일용 `duty/`가 있습니다. 에이전트 세션 말고 하네스가 더하는 장기 프로세스는 두 루프뿐이고, 런타임 의존성은 Bun 하나입니다.

### 두 가지 세션 런타임

세션은 herdr나 hc([herdr-core](https://releases.herdr.dev/core/install.sh))에서 돌고, 한 홈에 두 런타임의 세션이 섞여 있어도 됩니다. 하네스는 `src/runtime/`의 인터페이스 하나로 둘과 말하고, 저장된 레인과 역할은 자기를 연 런타임을 기억하므로, 어떤 런타임이 선택돼 있든 그 레인에 대한 명령은 원래 런타임으로 갑니다. 새 세션은 `DORI_RUNTIME`이 가리키는 런타임에서 열리고, 없으면 `$DORI_HOME/config.json`의 `"runtime": "herdr"`나 `"runtime": "hc"`를 따릅니다. 둘 다 없으면 hc 터미널 안에서는 hc, herdr 페인 안에서는 herdr, 그 밖에는 hc가 설치돼 있으면 hc, 아니면 herdr를 고릅니다. 기본 런타임은 hc이고, PATH에 둘 다 없으면 한 줄짜리 해결법과 함께 거부합니다. `dori-harness status`는 `RUNTIME hc (from config)`처럼 선택 결과를 맨 먼저 출력합니다. Windows에서는 herdr-core 공식 설치 프로그램으로 hc를 설치합니다.

hc에는 워크스페이스도 탭도 없습니다. Dori는 세션마다 이름 붙은 터미널을 하나 열고, 세션 상태는 에이전트가 직접 보내는 보고(최근 omo 빌드가 보내는 OSC 7501 시퀀스)로만 압니다. 보고하지 않는 에이전트는 `unknown`으로 남고 그 메시지는 인박스에서 기다립니다. `dori-harness migrate --to hc --all`(또는 `--lane <key>`, `--role duty-loop`, 계획만 보려면 `--dry-run`)은 세션을 다른 런타임으로 옮깁니다. 인계 브리프를 남기고, 대체 세션을 열고, 인박스를 옮기고, 옛 세션을 닫으며, 세션마다 `MIGRATED`, `SKIP`, `DEFERRED`, `MIGRATE_ROLLBACK`를 출력합니다. 동사별 대응표는 [`docs/runtime.md`](docs/runtime.md)에 있습니다.

## 하네스가 강제하는 것

### 목소리는 하나

여러분과 말하는 세션은 리드뿐입니다(`prompts/lead.md`). 레인 규칙은 여러분에게 갈 사실을 모두 리드에게 보내게 하고(`prompts/lane-footer.md`, 규칙 3), 당직 세션은 머지하지도 여러분과 말하지도 않습니다(`prompts/duty.md`).

### READY에는 증거가 필요하다

`dori-harness ready`는 `--evidence` 링크가 하나도 없거나 최종 답 텍스트가 없으면 거부합니다. 둘 다 레인 기록에 저장되고, `dori-harness done`은 `ready`가 아닌 레인을 거부하므로, 기록된 답 없이 닫히는 레인은 없습니다.

### 바쁜 페인은 끊지 않고, 두 번 보내지도 않는다

`dori-harness send`는 먼저 herdr에 페인의 에이전트 상태를 묻습니다. `idle`이나 `done`이면 바로 받고, 그 밖에는 `~/.dori/inbox/`에 쌓였다가 페인이 쉬면 당직 루프가 한 묶음으로 전달합니다. 셸이 앞에 떠 있는 페인에는 절대 타이핑하지 않습니다. 친 텍스트가 명령으로 실행되기 때문입니다.

텍스트가 이미 페인에 닿았을 수 있는 상태에서 전달이 실패하면, 나중에 Enter만 누르고, 그것도 원래 쳤던 에이전트에만 누릅니다. 그때 herdr가 다른 에이전트를 보고 있으면 항목을 붙잡아 두고 리드에게 `[DELIVERY-AMBIGUOUS <pane>]`로 한 번 알리며, `dori-harness inbox ack`나 `dori-harness inbox resend`로 손수 정리합니다.

### 10분, 20분, 40분의 재촉

10분 동안 보고가 없고 페인이 일하는 중도 아닌 레인은 페인에 `prompts/nudge.md`를 받고, 20분에 다시 받으며, 40분이면 당직 루프가 리드에게 `[ESCALATE <key>]`를 보냅니다. `--status waiting`으로 보고했거나 페인이 `blocked`인 레인은 건드리지 않습니다.

### 머지에는 정확한 head의 CLEAR 영수증과 초록 체크가 필요하다

`dori-harness merge`는 `gh`로 PR의 head SHA를 읽고, `~/.dori/receipts/`에 그 SHA에 대한 `CLEAR` 판정 영수증이 있어야 진행합니다. 영수증은 `dori-harness review`만 씁니다. 그 SHA에 고정된 새 비대화형 omo를 `prompts/review.md`로 돌리고, 리뷰어가 `VERDICT:` 줄을 출력하지 않으면 영수증을 쓰지 않습니다.

그다음 `gh pr checks`가 체크를 하나 이상 돌려줘야 하고, 모든 체크가 `pass`나 `skipping`이어야 하며, 적어도 하나는 `pass`여야 합니다. 체크 목록이 비면 "an empty check list is never green"으로 거부합니다. 리뷰 뒤에 푸시하면 head SHA가 바뀌므로 영수증이 맞지 않게 되고, `dori-harness review`를 다시 돌려야 합니다.

### 내 도구를 위한 훅

`$DORI_HOME/config.json`의 `hooks` 아래에 argv 템플릿을 둘 수 있습니다. `onReady`, `onReport`, `onLost`는 해당 사건이 생기면 백그라운드에서 돌고(인자마다 `{key}`, `{text}`, `{evidence}`가 채워집니다), `reviewCommand`는 같은 `VERDICT:` 줄을 출력하기만 하면 내장 리뷰어를 대신합니다. `DORI_PROMPTS_DIR`로 하네스가 여러분의 프롬프트 사본을 쓰게 할 수 있습니다.

## Dori mode 자세히

### 라우팅

질문, 상태 확인, 조회, 작은 수정은 Dori 자신의 세션에서 처리합니다. PR로 들어갈 코드, 여러 단계의 일, 길거나 병렬인 일은 레인을 받습니다. 그 저장소나 주제를 맡은 쉬고 있는 레인이 이미 있으면 일은 그쪽으로 갑니다. `dori can-launch`가 `HOLD`(메모리, 디스크, 페인 수가 가드의 선을 넘음)라고 하면 아무것도 열지 않고, 이유와 언제 시작할지를 알려 줍니다.

### 완료는 사실이 아니라 주장이다

`dori launch`는 감시자가 모든 신호를 직접 다시 읽을 수 있을 때만 `Done =` 줄을 받습니다. 신호는 `;`로 잇고, 모두 통과해야 레인이 완료됩니다.

| 신호 | 통과 조건 |
|---|---|
| `merged <owner/repo>#N` | PR이 머지됐고 머지 커밋이 있다 |
| `closed <owner/repo>#N` | 이슈가 닫혔다 |
| `published <pkg>@<version>` | npm에 정확히 그 버전이 있다 |
| `command ["argv","as","json"] [stdout~"regex"]` | 명령이 0으로 끝나고, 정규식이 있으면 stdout이 맞는다 |
| `file <path> [sha256=<hex>] [json:.a.b=<value>]` | 파일이 있고, sha256이 맞고, JSON 필드가 그 값과 같다 |
| `url <http(s) url> [status=200] [body~"regex"]` | GET이 그 상태 코드를 돌려주고, 정규식이 있으면 본문이 맞는다 |

레인은 `dori claim-done <key> --evidence "..."`로 완료를 주장합니다. `dori watch`가 5분 넘은 주장을 판정합니다. 푸시하지 않았거나 커밋하지 않은 작업, 실패한 신호는 이의가 되고, 아니면 레인을 닫습니다. 스레드 훅이 설정돼 있으면 스레드를 완료로 표시하고, 탭을 닫고, 워크트리를 지웁니다.

### PR을 완료라고 부르기 전에

`dori verify-pr <owner/repo> <num>`은 `gh api`로 PR을 읽어, 모든 커밋의 작성자와 커미터 이메일이 그 저장소에 설정된 신원과 같은지, 소스를 건드린 `fix:` 커밋에 바뀐 테스트나 `No test:` 사유가 붙어 있는지 확인합니다.

### 교훈

`dori lesson add`는 레인이 저장소에 대해 배운 규칙을, 그걸 가르쳐 준 증거와 묶어 기록합니다. `--global` 교훈은 리드가 모든 레인에 거는 상시 규칙입니다. `dori launch`는 지금 유효한 교훈을 다음 브리프 위에 붙입니다.

### 감독

`freshness` 틱마다 실행 중인 레인을 벽시계 분, 토큰, 비용(설정한 사용량 명령에서 읽음)의 선택적 상한과 대조하고, `Working` 타이머가 새 보고, 체크포인트, 파일 변경 없이 20분 동안 늘기만 하면 레인을 stalled로 표시합니다. 상한에 닿은 레인을 죽이지는 않습니다. 리드를 기다립니다.

### 기다리라고 할 때

`dori pause <key>`는 레인의 목표를 멈추고 돌고 있는 턴을 중단하며, 멈춤을 확인하지 못하면 `PAUSE_UNVERIFIED`를 출력합니다. `dori resume <key>`로 다시 시작합니다.

## 같은 구조, 같은 철학

DeepSeek은 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)(첫 커밋 2026-10-31)을 공개하고, 하루쯤 뒤 "Exploring Super-agent Design: Towards a More Autonomous Agent System"이라는 글을 냈습니다. 그 문서를 Dori 옆에 놓으면 개념이 파이프라인에서도, [철학 문서](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md)의 규칙에서도 하나씩 맞아떨어집니다.

![Dori vs DeepSeek](docs/dori-vs-deepseek.ko.png)

| DeepSeek dsh-superagent | Dori |
|---|---|
| 출처: GitHub, Feishu | Dori는 채팅에 산다: Slack, Discord, Telegram |
| Trigger, 그다음 Eval, 그다음 Ticket | 채팅으로 받은 일 하나가 브리프 하나를 가진 레인 하나가 된다 |
| 티켓마다 Executor 세션: 세션 하나, 작업 디렉터리 하나 | 일마다 코딩 에이전트 세션 하나, 자기 herdr 탭에서, 여럿이 병렬로 |
| Channel: 원래 대화에서 답한다, 예를 들면 PR과 함께 | 같은 스레드에서 보고, 일마다 상태 메시지 하나를 제자리에서 고침 |
| Panel: 사람이 필요한 것만 보여 준다 | 리드는 되돌릴 수 없거나 제품을 바꾸는 결정만 묻는다 |
| 사람의 주의는 최소로, 가치는 최대로 | 짧은 메시지, 이모지 없음, 알림은 머지 뒤에만 |
| 요청받았거나 팀 규칙이 허락할 때만 움직인다 | Dori는 아무도 요청하지 않은 일을 시작하지 않는다. 백로그엔 여러분이 넣은 것만 있다 |
| 사람이 움직여야 할 때만, 한 번에 한 질문 | 결정은 번호 붙은 선택지와 Dori 자신의 추천으로 온다 |
| 정직하게 보고하고, 막힌 걸 우회하지 않는다 | 증거 없는 "완료"는 없고, 막힌 건 막혔다고 보고한다 |

우리는 이 형태를 공개적으로 약 6개월 동안 돌려 왔습니다.

- 2026-04-18: omo에 팀 모드가 들어옴. 터미널 페인마다 워크트리를 가진 여러 에이전트 세션([f1268c0](https://github.com/code-yeongyu/oh-my-openagent/commit/f1268c0), [e303fee](https://github.com/code-yeongyu/oh-my-openagent/commit/e303fee)).
- 2026-05-06: Dori라는 이름이 omo README에 들어옴([#3807](https://github.com/code-yeongyu/oh-my-openagent/pull/3807)).
- 2026-10-07: 이 저장소가 Dori mode를 `omo-dori-mode-experimental`로 공개([ce53e4d](https://github.com/sisyphuslabs/dori-superagent/commit/ce53e4d)).
- 2026-10-31: DeepSeek 프로토타입의 첫 커밋.

omo 자체도 이렇게 만들어집니다. 2026-07-13부터 2026-11-08까지 [code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)는 모든 기여자를 합쳐 풀 리퀘스트 2,846개를 머지하고 커밋 18,780개를 쌓았고, 이 구성의 완전판으로 만들었습니다. 이 저장소의 하네스는 최소판, 즉 herdr와 omo만으로 도는 부분입니다.

## 설정

하네스 환경 변수:

| 변수 | 기본값 | 의미 |
|---|---|---|
| `DORI_HOME` | `~/.dori` | 상태 디렉터리 |
| `DORI_AGENT_CMD` | `omo` | 각 페인이 실행하는 에이전트 |
| `DORI_HERDR_SESSION` | | 이름 붙은 herdr 세션 |
| `DORI_RUNTIME` | 지금 안에 있는 런타임, 아니면 PATH에 있으면 `hc`, 아니면 `herdr` | 새 세션을 열 런타임: `herdr` 또는 `hc`(같은 프로젝트의 헤드리스 세션 런타임 herdr-core). `$DORI_HOME/config.json`의 `runtime` 키도 같은 일을 하고, PATH에 둘 다 없고 아무것도 설정되지 않았고 주변에 어느 쪽 페인이나 터미널도 없으면 한 줄짜리 해결법과 함께 거부합니다 |
| `DORI_CMD` | `src/cli.ts`의 전체 경로 | 에이전트에게 알려 줄 dori 호출 방법 |
| `DORI_PROMPTS_DIR` | 저장소의 `prompts/` | 여러분의 프롬프트 파일 |
| `DORI_MAX_LANES`, `DORI_MAX_STARTS`, `DORI_MAX_LOAD` | 3, 2, 코어 수 | 매시 루프 예산 |
| `DORI_TELEMETRY`, `DORI_TELEMETRY_ENDPOINT` | 켜짐, `https://t.omo.dev` | `0`이면 텔레메트리를 끕니다 |

Dori mode는 `~/.dori/config.json`(또는 `DORI_CONFIG`)을 읽습니다. 모든 필드는 선택이고 [`config.example.json`](skills/dori-mode/references/config.example.json)에 전부 나와 있습니다. 먼저 정할 것은 `leadPane`, `laneWorkspace`, `defaultCwd`, `agentCommand`와 `defaultModel`, `repoIdentities`(`verify-pr`가 저장소마다 기대하는 Git 이름과 이메일), `hooks.threadReply`와 `hooks.threadDone`(`{thread}`와 `{text}`를 쓰는 argv 템플릿으로 적은 메신저 CLI), `hooks.transcribe`, `guard`(부하, 남은 메모리, 남은 디스크, 페인 수)입니다. 기본 타이밍은 조용한 15분 뒤 재촉, 20분 뒤 마지막 보고를 스레드에 게시, 5분 뒤 완료 주장 판정입니다.

## 컨테이너에서 돌리기

[`examples/container/`](examples/container/)에는 gh, node, bun, herdr, agent-messenger, omo, 하네스를 담은 장기 실행 컨테이너 하나를 위한 Dockerfile, compose 파일, 엔트리포인트가 있습니다. 내려받는 바이너리는 모두 고정된 sha256과 대조하고, npm 패키지와 하네스는 버전과 커밋으로 고정합니다. 공개된 이미지는 없습니다. 직접 빌드하고, 실행 중인 컨테이너 안에서 로그인을 한 번 하면 이름 붙은 볼륨이 그걸 유지합니다. 빌드, 첫 실행, 붙는 방법은 [`docs/container.md`](docs/container.md)에 있습니다.

## 텔레메트리

dori는 omo와 같은 방식으로 익명 사용량 집계를 보냅니다. OTLP/HTTP JSON 로그를 `https://t.omo.dev`의 omo 수집기로 보냅니다. 신원은 `~/.dori/telemetry.json`에 둔 무작위 설치 id이고, 그 sha256만 전송합니다. 첫 전송 때 수집기가 그 해시로 설치별 수집 키를 발급하므로, 코드에 공용 키는 없습니다. 첫 실행 때 한 줄 안내가 나옵니다. `DORI_TELEMETRY=0`으로 끄고, `DO_NOT_TRACK=1`도 됩니다.

| 이벤트 | 시점 | 필드 |
|---|---|---|
| `dori.installed` | 첫 실행 | 없음 |
| `dori.daily_active` | UTC 기준 하루 한 번, 아무 dori 명령에서 | `day_utc` |
| `dori.lane_started` | `dori-harness start` | `open_lanes` |
| `dori.lane_ready` | `dori-harness ready` | `evidence_count`, `lane_minutes` |
| `dori.review_completed` | `dori-harness review` | `verdict`: `CLEAR` 또는 `BLOCK` |
| `dori.merge_decided` | `--dry-run` 없는 `dori-harness merge` | `outcome` |
| `dori.duty_summary` | 당직 루프에서 많아야 한 시간에 한 번 | `ticks`, `flushed`, `nudges`, `escalations`, `lost` |

모든 기록에는 서비스 이름과 버전, 설치 해시, CI 여부, OS 종류와 버전, CPU 아키텍처도 들어갑니다. 경로, 저장소 이름, PR 번호, 레인 키, 브리프, 메시지 같은 텍스트는 절대 보내지 않습니다. 명령은 전송을 최대 2초만 기다리고, 텔레메트리 실패로 명령이 실패하지는 않습니다.

## 테스트와 개발

```sh
bun test ./test/                                  # the harness: 386 tests across 42 files, no model calls
cd skills/dori-mode/scripts && bun install && bun test   # Dori mode: 321 tests across 44 files
bun run ci                                        # biome, tsc, knip, the 250-line check, both suites
```

하네스 테스트는 가짜 herdr, 가짜 hc, 가짜 gh와 테스트가 움직이는 시계로 돕니다. 엔드투엔드 테스트는 진짜 herdr 서버나 진짜 hc 코어를 격리된 세션에서 띄우고 omo 자리에 가짜 에이전트 스크립트를 두며, 바이너리가 PATH에 없으면 스스로 건너뜁니다. Dori mode 테스트는 가짜 herdr, git, gh로 돌고 진짜는 아무것도 건드리지 않습니다. CI는 같은 것을 Ubuntu와 macOS에서 돌립니다.

Windows 프로필에는 따로 테스트가 있습니다(Windows 전용): `cd profile; bun test`. `bun scripts/check-paths.ts`는 추적되는 파일에 하드코딩된 사용자 경로나 개인 값이 있으면 실패합니다.

## 이게 아닌 것

하네스는 최소판이지 우리의 프로덕션 스택이 아닙니다. 일부러 뺀 것은 머신 간 메시, 무거운 슬롯 스케줄링, 채팅과 티켓 트래커 브리지, 테스트 스위트 전체에 대한 영수증입니다. herdr와 omo만으로 도는 부분은 여기 있습니다. 역할, 레인, 인박스, 당직 루프, 매시 루프와 백로그, 리뷰와 머지 게이트입니다. Dori mode는 자기 메신저 부품, 호스트 가드, 무거운 슬롯 러너를 가진 별도 CLI이고, 하네스는 거기서 아무것도 가져오지 않습니다.

## 기여

모든 기여자는 첫 풀 리퀘스트에 `I have read the CLA Document and I hereby sign the CLA`라고 댓글을 달아 [기여자 라이선스 계약](https://github.com/sisyphuslabs/dori-superagent/blob/main/CLA.md)에 한 번 서명합니다. CLA Assistant 체크가 그걸 기록합니다. 게이트, 테스트 명령, 풀 리퀘스트 규칙은 [CONTRIBUTING.md](CONTRIBUTING.md)에 있습니다.

## 라이선스

업스트림 [7ac0ed7](https://github.com/sisyphuslabs/dori-superagent/commit/7ac0ed761dfb6aa0b3a81e8740a29cde5cbd0444) 포트부터 win-dori는 업스트림과 같이 [Sustainable Use License](LICENSE) 1.0을 따르고, 서드파티 구성 요소는 각자의 라이선스를 따릅니다. 개인 사용, 사내 업무용 사용, 무료 비상업적 사용이 허용되며, 상업적 사용에는 소유자인 Sisyphus Labs의 라이선스가 필요합니다. win-dori가 무엇을 바꿨는지는 [NOTICE.md](NOTICE.md)에 있습니다. `fa86ddf`까지의 win-dori 버전은 MIT였고 그대로 MIT입니다. `prompts/`의 프롬프트는 에이전트가 실제로 받는 지시문이고, 믿기 전에 읽어 볼 만큼 짧습니다.
