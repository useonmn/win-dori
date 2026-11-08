# win-dori

> **win-dori è il port per Windows di [sisyphuslabs/dori-superagent](https://github.com/sisyphuslabs/dori-superagent).** Dori e dori-superagent sono un progetto di Sisyphus Labs; win-dori segue il commit upstream [7ac0ed7](https://github.com/sisyphuslabs/dori-superagent/commit/7ac0ed761dfb6aa0b3a81e8740a29cde5cbd0444) e mantiene il comportamento e i valori predefiniti di upstream. Aggiunge solo ciò che serve a Windows: l'installazione da PowerShell, pane che riconoscono la propria shell e un profilo Windows con avvio automatico e listener Slack. Il merito di Dori va agli autori upstream, i bug nelle parti Windows sono nostri. Le issue di upstream vanno su [sisyphuslabs/dori-superagent/issues](https://github.com/sisyphuslabs/dori-superagent/issues).

> **Licenza.** Da questo port win-dori è sotto la [Sustainable Use License](LICENSE), come upstream: solo uso personale, uso interno aziendale e uso non commerciale gratuito. [NOTICE.md](NOTICE.md) dice cosa ha modificato win-dori. Le versioni fino a `fa86ddf` erano MIT e restano MIT.

**Dori vive nella tua chat. Digli cosa fare in Slack, Telegram o Discord: ogni richiesta ottiene la propria sessione di coding agent, seguita fino al merge. Prima del merge serve una review CLEAR esattamente su quel head.**

[English](README.md) | [한국어](README.ko.md) | [简体中文](README.zh.md) | [日本語](README.ja.md) | [Deutsch](README.de.md) | Italiano

<p align="center">
  <img src="skills/dori-mode/assets/dori-avatar.png" alt="Dori" width="120">
</p>

Dori è un harness per coding agent multi-sessione di [Sisyphus Labs](https://sisyphuslabs.ai). Con te parla una sola sessione lead. Una richiesta diventa una lane: una sessione [omo](https://github.com/code-yeongyu/oh-my-openagent) in un proprio tab di [herdr](https://github.com/herdrdev/herdr), con un brief scritto, e resta aperta finché le sue prove non vengono rilette sul sistema reale. Un ciclo duty tiene in movimento le lane silenziose, un gate di merge sta tra il lavoro e `main`.

Qui ci sono due programmi. In win-dori l'harness si chiama `dori-harness` (upstream lo chiama `dori`) e la CLI di messaggistica del Dori mode si chiama `dori`, quindi possono stare entrambi sulla stessa macchina. Dove il testo di upstream dice `dori up` o `dori merge`, win-dori usa `dori-harness up` e `dori-harness merge`.

| Pezzo | Cos'è | Quando serve |
|---|---|---|
| L'harness (`src/`, `prompts/`) | lead, lane, ciclo duty, ciclo orario, review e gate di merge | vuoi l'intero ciclo su una macchina |
| Dori mode (`skills/dori-mode`) | la CLI per i messenger: invio, ricezione, presenza, protocollo di chiusura | vuoi parlargli dalla chat |

## Cosa ottieni

| Ottieni | Cosa significa | Dove sta |
|---|---|---|
| Lavoro in parallelo, non in coda | ogni richiesta apre un proprio tab e una propria sessione agent; più richieste girano insieme | `dori-harness start`, `src/lanes.ts` |
| Un done che deve dimostrarsi | una lane finisce con `dori-harness ready --evidence <link>`, e il lead la chiude solo dopo aver riletto quel link sul reale | `ready()` in `src/lanes.ts`, `prompts/lane-footer.md` |
| Sessioni mai interrotte | un messaggio a un pane occupato va in coda e arriva in blocco quando il pane è idle | `src/inbox.ts` |
| Il silenzio si nota | uno stimolo a 10 e a 20 minuti, un'escalation al lead a 40 | `NUDGE_MINUTES` in `src/duty.ts` |
| Trova da solo il prossimo lavoro | il ciclo orario pesca da un backlog, rispetta i limiti di lane e di host e ti chiede solo le decisioni | `src/loop.ts`, [docs/hourly-loop.md](docs/hourly-loop.md) |
| Stato in un posto solo | un messaggio per richiesta, modificato sul posto invece di essere ripubblicato | `edit` in `skills/dori-mode/scripts/src/messenger/` |
| Una voce sola | le lane e la sessione duty non parlano mai con te, tutto arriva al lead | `prompts/lead.md`, `prompts/duty.md` |
| Risponde come scrivi tu | niente emoji in ciò che scrive, messaggi brevi, la lingua del thread | `skills/dori-mode/SKILL.md` |

![architecture](docs/architecture.png)

## Parlagli dalla tua chat

Questo repository implementa tre canali. Ognuno pubblica, modifica un messaggio sul posto e risponde in thread.

| Canale | Inviare e modificare | Ricevere | Mostrarsi online | Cosa impostare |
|---|---|---|---|---|
| Slack | pubblicare, rispondere in thread, modificare sul posto | vista thread, thread in cui hai pubblicato, DM e menzioni | sì, con un user token | `DORI_SLACK_TOKEN`, più `DORI_SLACK_COOKIE` per un user token |
| Telegram | pubblicare, rispondere in un topic del forum, modificare sul posto | DM del proprietario, un topic di gruppo, modifiche, file id dei media | non si applica a un bot | `DORI_TELEGRAM_TOKEN`, `DORI_TELEGRAM_OWNER_ID`, facoltativi `DORI_TELEGRAM_GROUP_ID` e `DORI_TELEGRAM_TOPIC_ID` |
| Discord | pubblicare, pubblicare in un thread, modificare sul posto | non presente in questo repository | sì, con una connessione gateway | `DORI_DISCORD_TOKEN` |

### Slack

Un user token agisce come un membro vero: richiede un posto a pagamento, vede tutto ciò che vede quel membro, e `dori presence slack` può mantenere il pallino verde. Un bot token non costa posti, vede solo i canali a cui è stato invitato e appare come app. Scegli e annotalo, perché da questo dipende cosa può leggere l'onboarding.

```powershell
$env:DORI_SLACK_TOKEN = "xoxp-..."
$env:DORI_SLACK_COOKIE = "..."          # il cookie `d`, solo con user token

dori send slack --to C0123456789 --text "PR #12 è verde" --thread 1712345678.123456
dori send slack --to C0123456789 --edit 1712345678.123456 --text "PR #12 è mergiata"
dori inbound slack --loop 1           # righe INBOUND, una per messaggio nuovo
dori presence slack                   # user token: restare visibile online
```

Una risposta senza menzione sotto un thread aperto da Dori arriva comunque. La ricezione legge tre posti: la vista thread di Slack, ogni thread in cui Dori ha pubblicato (registrato in `<stateDir>/slack-threads.json`), e DM, DM di gruppo e menzioni non letti.

### Telegram

```powershell
$env:DORI_TELEGRAM_TOKEN = "..."
$env:DORI_TELEGRAM_OWNER_ID = "123456789"      # solo questo account è una richiesta
$env:DORI_TELEGRAM_GROUP_ID = "-1001234567890" # facoltativo: un gruppo
$env:DORI_TELEGRAM_TOPIC_ID = "42"             # facoltativo: un topic del forum al suo interno

dori send telegram --to -1001234567890 --thread 42 --text "PR #12 è verde"
dori inbound telegram --loop 1
```

La ricezione è limitata al proprietario: i DM del proprietario configurato passano sempre, in un gruppo passa solo il topic configurato, i messaggi dei bot non passano mai. Le modifiche arrivano come messaggio a sé. Una nota vocale, una foto o un documento arrivano come riga con il suo `file_id`, che passi a `getFile` di Telegram; `dori transcribe <file>` trasforma poi l'audio scaricato in testo tramite `hooks.transcribe`.

### Discord

```powershell
$env:DORI_DISCORD_TOKEN = "..."

dori send discord --to 123456789012345678 --text "PR #12 è verde"
dori presence discord                 # restare visibile online sul gateway
```

L'invio funziona, compreso pubblicare in un thread che passi come `--thread`. La ricezione è la lacuna: `dori inbound` accetta solo `slack` e `telegram`, e la connessione gateway di Discord in questo repository si identifica e manda heartbeat senza consegnare messaggi in arrivo. Per il lato piattaforma `references/setup.md` fa installare agent-messenger a Dori, e il resto lo leggi dall'API attuale della tua piattaforma.

### Anche nella libreria, non su un comando

Ogni modulo messenger è una classe tipizzata che puoi importare, e fa più di quanto esponga la CLI:

- upload di file su Slack (URL di upload, poi completamento) in `skills/dori-mode/scripts/src/messenger/slack.ts`
- topic del forum di Telegram (creare, rinominare, chiudere, riaprire), streaming in bozza con partenza `Thinking…` e tabelle HTML in `skills/dori-mode/scripts/src/messenger/telegram.ts`
- creazione, rinomina e archiviazione dei thread di Discord in `skills/dori-mode/scripts/src/messenger/discord.ts`

L'elenco completo dei moduli è in [skills/dori-mode/references/scripts.md](skills/dori-mode/references/scripts.md).

### Nessun altro canale

Questo repository non supporta Teams, WhatsApp, LINE, WeChat, iMessage, KakaoTalk o Lark, e `dori send` rifiuta un canale che non conosce. Sisyphus Labs pubblica per il prodotto ospitato un elenco di piattaforme più lungo, con la stessa nota che questo README riporta: il Dori mode distribuito copre Telegram, Discord e Slack.

## Installazione

Ti servono [Bun](https://bun.sh) 1.4.4 o più recente, git, [herdr](https://herdr.dev) oppure herdr-core `hc` (vedi [Runtime](#runtime)), [omo](https://github.com/code-yeongyu/oh-my-openagent) (l'agente di coding che gira nei pane) e la CLI di GitHub `gh` per review, check e merge.

### Windows

In PowerShell, da qualsiasi cartella:

```powershell
irm https://raw.githubusercontent.com/useonmn/win-dori/main/install.ps1 | iex
```

Da un checkout puoi anche lanciare `install.cmd` in cmd.exe; chiama `install.ps1` con gli stessi argomenti.

Questa riga è tutta l'installazione. Serve git (se manca e c'è winget, installa `Git.Git`) e installa bun e herdr con i loro installer ufficiali quando mancano (`DORI_NO_DEPS=1` lo disattiva). Installa in `%USERPROFILE%\.dori\src`, e rilanciarla aggiorna quella copia (`DORI_NO_PULL=1` salta il pull). Collega lo skill in `%USERPROFILE%\.agents\skills\dori-mode` come directory junction, quindi non servono diritti di amministratore né la modalità sviluppatore. Esegue `bun install` e `bun link` e aggiunge la cartella bin globale di bun al PATH utente. Poi installa il profilo Windows da `profile/`. `DORI_SKIP_PROFILE=1` lo salta e copia invece la configurazione di esempio in `%USERPROFILE%\.dori\config.json`. `DORI_SRC`, `SKILLS_DIR` e `DORI_HOME` cambiano quei percorsi, e `DORI_REPO` punta a un fork. Alla fine apri un nuovo terminale, così il PATH aggiornato vale.

Poi apri herdr, avvia omo al suo interno e di' "Dori mode".

### Profilo Windows

Il profilo tiene il Dori in funzione anche dopo un riavvio, qualunque messenger tu scelga: uno script di avvio, una configurazione, un'attività di avvio automatico e, per Slack, un listener in entrata in Socket Mode con le regole dei canali e il manifest dell'app. Niente al suo interno nomina un utente, una cartella o un canale; ogni percorso viene da `%USERPROFILE%` e ogni id dai tuoi token.

La prima volta che dici "Dori mode", il Dori si configura da solo nella conversazione. Chiede il messenger e apre un file di Blocco note che solo tu puoi leggere per i token (non incollare mai un token in chat). `dori setup <messenger>` li verifica, ricava gli id che può, salva `%USERPROFILE%\.dori\<messenger>.env` (`slack.env`, `telegram.env` o `discord.env`) leggibile solo dal tuo utente Windows e registra l'attività `Dori Autostart`. Da lì in poi, all'accesso parte herdr, si apre un workspace con il nome del tuo Dori e l'agente si avvia lì.

Il listener Slack segna ogni messaggio preso in carico con una reazione a occhi e uno stato di lavoro nel thread, e sostituisce gli occhi con una spunta quando il Dori risponde.

Rilanciare il passo del profilo è sicuro. I file che hai modificato restano e la differenza viene mostrata; `config.json` viene solo creato, mai sostituito. `DORI_DRY_RUN=1` mostra un'anteprima, `DORI_FORCE=1` sostituisce i file modificati e tiene una copia `.bak-<time>`, `DORI_NO_TASK=1` non registra mai l'attività, e ogni esecuzione scrive `%USERPROFILE%\.dori\undo-profile-<time>.ps1`, che la annulla. [profile/INVENTORY.md](profile/INVENTORY.md) elenca ogni pezzo, e `profile\install-profile.ps1 -DryRun` dal checkout esegue solo il passo del profilo.

### Runtime

Le lane girano in herdr o in herdr-core `hc`. La scelta segue quest'ordine, vince la prima corrispondenza: `DORI_RUNTIME`, poi la chiave `runtime` in `config.json`, poi `HC_TERMINAL_ID` (sei dentro hc), poi `HERDR_PANE_ID` (sei dentro herdr), poi l'unico dei due binari presente nel PATH. Con solo herdr nel PATH, il predefinito è herdr. Su Windows hc si installa con l'installer ufficiale di herdr-core.

### macOS e Linux

```sh
curl -fsSL https://raw.githubusercontent.com/useonmn/win-dori/main/install.sh | bash
```

Clona il repo in `~/.dori/src`, collega lo skill in `~/.agents/skills/dori-mode`, mette `dori` nel PATH e copia la configurazione di esempio in `~/.dori/config.json`.

### L'harness da un checkout

```powershell
git clone https://github.com/useonmn/win-dori
cd win-dori
bun install
bun link        # mette `dori-harness` nel PATH; altrimenti usa `bun src/cli.ts`
```

Poi imposta in `~/.dori/config.json` almeno `leadPane` (da `herdr pane current`), `laneWorkspace` e `defaultCwd`.

### Note su Windows

- I token stanno in `~/.dori/<messenger>.env`, mai nelle variabili d'ambiente dell'utente. `dori` legge da solo quel file (o quello in `DORI_ENV_FILE`). Per una shell usa e getta, impostali come negli esempi sopra con `$env:DORI_SLACK_TOKEN = "xoxp-..."`.
- L'harness digita comandi nei pane, quindi rileva la shell di ogni pane e mette le virgolette di conseguenza: pwsh, Windows PowerShell 5.1, cmd o Git Bash. `DORI_PANE_SHELL` (`posix`, `pwsh`, `powershell` o `cmd`) sostituisce il rilevamento.
- Il guard dell'host legge carico, memoria, swap e disco con una sola chiamata a `powershell.exe`. Il carico è l'uso della CPU per il numero di CPU più la coda del processore, quindi oscilla più della media a 1 minuto di Unix.
- I comandi `Done =` sono liste argv come `["bun","test"]`, così la stessa riga funziona su Windows, macOS e Linux.

## Avvio rapido

Avvia il server di herdr, poi tira su l'harness:

```sh
dori-harness up
# UP lead=w1:p1 duty=w1:p2 loop=w1:p3 hourly=w1:p4 home=~/.dori
```

Si apre un workspace herdr chiamato `dori` con il lead dentro, una sessione omo a cui viene aggiunto `prompts/lead.md` al system prompt, e sotto la sessione duty, il ciclo duty e il ciclo orario. Parla con il lead. Scrive un brief (obiettivo, input, risultato atteso, condizione di stop, vincoli; vedi [examples/brief.md](examples/brief.md)) e apre le lane da solo, oppure ne apri una tu dalla shell:

```sh
dori-harness start fix-flaky-login --brief examples/brief.md
# STARTED fix-flaky-login pane=w1:p5 brief=~/.dori/briefs/fix-flaky-login.md

dori-harness status
# lead=w1:p1 duty=w1:p2 home=~/.dori
# fix-flaky-login         working  w1:p5    active 0m ago  start: examples/brief.md
```

La chiave di una lane corrisponde a `^[a-z][a-z0-9-]{1,40}$`, e una chiave già aperta viene rifiutata. Dentro la lane l'agent riporta e chiude con i comandi che le regole della lane gli passano:

```sh
dori-harness report fix-flaky-login --text 'riprodotto: 1 errore su 20 esecuzioni, fixture di sessione condivisa'
dori-harness report fix-flaky-login --status waiting --text 'WAITING: check su owner/repo#12'
dori-harness ready fix-flaky-login --text 'causa corretta, check verdi' --evidence https://github.com/owner/repo/pull/12
# READY fix-flaky-login
```

Il lead legge `[READY fix-flaky-login]` nel suo pane e fa girare il gate da sé:

```sh
dori-harness review owner/repo#12             # un reviewer omo nuovo, fissato al head, scrive una receipt
dori-harness merge owner/repo#12 --dry-run    # MERGE_OK owner/repo#12 head=<sha> (dry run), oppure MERGE_REFUSED <motivo>
dori-harness merge owner/repo#12              # gh pr merge --squash --match-head-commit <sha>
dori-harness done fix-flaky-login             # chiude il tab della lane; solo una lane READY si può chiudere
```

`dori-harness send <lead|duty|key|pane> --text '...'` consegna a un pane o mette in coda mentre è occupato. Senza `--text` legge da stdin. I comandi che ricevono gli agent vengono resi con il percorso completo di `src/cli.ts` e `DORI_HOME` impostato, così non dipendono mai da quale `dori` sta nel tuo PATH.

## Come funziona

![lane lifecycle](docs/lane-flow.png)

Il lead è l'unica sessione che parla con te. Trasforma una richiesta in un brief, apre una lane, legge quello che le lane rimandano e fa i merge.

Una lane è una sessione agent in un proprio tab, avviata con un brief e le regole della lane aggiunte in coda (`prompts/lane-footer.md`). Riporta le tappe con `dori-harness report` e chiude con `dori-harness ready`, che senza un link di prova non esce. Tutto ciò che fa una lane arriva al lead come una riga: `[START]`, `[REPORT]`, `[READY]`, `[LOST]`, `[ESCALATE]`.

Il ciclo duty è `dori-harness duty --interval 60`, un processo normale accanto a una sessione duty. A ogni tick svuota i messaggi in coda nei pane tornati idle, stimola le lane silenziose, escala al lead e segna come persa una lane il cui pane è sparito.

Il ciclo orario è `dori-harness loop`. Una volta all'ora allinea il backlog alla realtà, controlla il lavoro saltato, avvia la prossima voce che non richiede decisioni, pone ogni domanda aperta una volta e manda un report. Non fa mai merge, non fa mai push e non chiude mai un pane.

Lo stato è JSON su disco sotto `~/.dori` (o `$DORI_HOME`): `lanes/`, `inbox/`, `briefs/`, `receipts/`, più `backlog/` e `loop/` per il ciclo orario e `duty/` per il suo file di stop. Gli unici processi lunghi che l'harness aggiunge sono questi due cicli, e l'unica dipendenza a runtime è Bun.

### Il gate di merge

`dori-harness merge` legge lo SHA del head della PR con `gh` e rifiuta con un motivo nominato:

| Rifiuto | Significato |
|---|---|
| `no_receipt` | nessuna receipt di review CLEAR esattamente su questo head |
| `review_block` | la receipt su questo head dice BLOCK |
| `no_checks` | la lista dei check è vuota, e una lista vuota non è mai verde |
| `checks_red` | un check è fallito |
| `checks_all_skipped` | tutti i check sono stati saltati, quindi nulla è passato |

Le receipt le scrive `dori-harness review` e nient'altro. Fa girare un omo non interattivo e nuovo su `prompts/review.md`, fissato al head, e un reviewer che non stampa una riga `VERDICT:` non scrive nessuna receipt. Un push dopo la review sposta il head, quindi la vecchia receipt non vale più.

`hooks.reviewCommand` in `~/.dori/config.json` sostituisce il reviewer integrato con un tuo comando, che deve stampare la stessa riga `VERDICT:`.

## Riferimento dei comandi

L'harness, `src/cli.ts`:

| Comando | Fa |
|---|---|
| `dori-harness up [--cwd DIR]` | apre i pane di lead, duty, ciclo duty e ciclo orario |
| `dori-harness start <key> --brief FILE [--cwd DIR]` | apre una lane: nuovo tab, sessione agent, brief più regole della lane |
| `dori-harness report <key> --text T [--status working\|waiting]` | una lane registra una tappa o un'attesa |
| `dori-harness ready <key> --text T --evidence LINK` | una lane chiude; rifiuta senza prove |
| `dori-harness review <owner/repo#N> [--model M]` | reviewer nuovo sul head esatto, scrive una receipt |
| `dori-harness merge <owner/repo#N> [--dry-run]` | receipt CLEAR più check verdi, poi merge squash |
| `dori-harness done <key>` | il lead chiude una lane READY |
| `dori-harness status` | ruoli e ogni lane aperta |
| `dori-harness duty [--once] \| stop \| resume \| status` | il ciclo duty e il suo interruttore |
| `dori-harness loop [--once] \| stop \| resume \| status` | il ciclo orario e il suo interruttore |
| `dori-harness backlog add \| list \| decide \| drop \| import` | la coda da cui pesca il ciclo orario |
| `dori-harness send <target> --text T` e `dori-harness inbox list\|ack\|resend` | consegna, coda e risoluzione di una consegna trattenuta |
| `dori-harness role <lead\|duty> [PANE]` | registra un pane se non hai usato `dori-harness up` |

`bun src/cli.ts` senza argomenti stampa lo stesso elenco con tutti i flag.

Dori mode, `skills/dori-mode/scripts/src/cli.ts`:

| Comando | Fa |
|---|---|
| `dori launch <key> --title T --brief FILE --done "..."` | apre una lane, con limiti facoltativi di tempo, token e costo |
| `dori claim-done` e `dori object-done` | il flusso di chiusura da 5 minuti |
| `dori close <key>` | chiude una lane i cui segnali `Done =` sono stati riletti sul reale |
| `dori sync` / `dori boot` | registry contro i pane vivi; il controllo in sola lettura dopo un riavvio |
| `dori freshness` / `dori dead-panes` / `dori guard` / `dori heavy` | stimolare, rilevare, osservare il carico, limitare i comandi pesanti |
| `dori send` / `dori inbound` / `dori presence` / `dori transcribe` | i comandi messenger qui sopra |
| `dori worklog` / `dori lesson` / `dori checkpoint` | il registro delle richieste, le lezioni per repo, i passi completati |

`dori launch --dry-run` stampa il brief come lo riceverà la lane.

## Estenderlo

Gli hook del ciclo di vita in `~/.dori/config.json` chiamano un tuo programma a ogni transizione, come array argv con `{key}`, `{text}`, `{evidence}`, `{repo}`, `{number}` e `{sha}` riempiti per singolo argomento, mai passando da una shell:

| Hook | Scatta |
|---|---|
| `hooks.onReady` | una lane chiude con prove |
| `hooks.onReport` | una lane riporta |
| `hooks.onLost` | il pane di una lane sparisce |
| `hooks.reviewCommand` | sostituisce il reviewer integrato |

Un hook bloccato non tiene aperto un comando: la CLI aspetta al massimo due secondi quelli ancora in corso e lo dice. `DORI_PROMPTS_DIR` sostituisce i quattro file di prompt con i tuoi, `DORI_AGENT_CMD` sostituisce `omo` con un altro binario agent, e `DORI_HOME` sposta la directory di stato.

## In un container

[examples/container](examples/container) costruisce un'immagine Ubuntu con gh, node, bun, herdr, omo e l'harness fissati, un servizio `dori` e volumi nominati per ogni parte dello stato. Non esiste un'immagine pubblicata: la costruisci in locale e fai l'accesso una volta dentro. [docs/container.md](docs/container.md) descrive la build, i volumi che sopravvivono a un riavvio e il dimensionamento.

## Test

```sh
bun run test        # 275 test in ./test/
bun run test:skill  # 308 test in skills/dori-mode/scripts
bun run ci          # Biome, tsc, knip, il limite delle 250 righe, poi entrambe le suite
```

Nessuna delle due suite richiede un modello o la rete: l'harness gira contro un herdr finto e un `gh` finto, Dori mode contro herdr, git e `gh` finti. Due test end-to-end avviano un herdr vero e si saltano da soli quando `herdr` non è nel PATH.

Il profilo Windows ha i suoi test (solo Windows): `cd profile; bun test`. `bun scripts/check-paths.ts` fallisce quando un file tracciato contiene un percorso utente scritto a mano o un valore personale.

## Telemetria

`dori` invia conteggi anonimi d'uso come fa omo: OTLP/HTTP JSON a `https://t.omo.dev`, con un id di installazione casuale in `~/.dori/telemetry.json` e solo il suo sha256 in uscita. Quello che lascia la macchina sono conteggi ed enum fissi: installato, attivo giornaliero, lane avviata, lane ready, review completata, merge deciso e un riepilogo duty ogni ora. Mai inviati: percorsi, nomi di repository, numeri di PR, chiavi di lane, brief, messaggi o altro testo. Si disattiva con `DORI_TELEMETRY=0` (funziona anche `DO_NOT_TRACK=1`) e si redirige con `DORI_TELEMETRY_ENDPOINT`. La telemetria non fa mai fallire un comando.

## Contribuire

Chi contribuisce firma una volta il [Contributor License Agreement](https://github.com/sisyphuslabs/dori-superagent/blob/main/CLA.md), prima che una sua pull request venga revisionata o mergiata, commentando nella pull request: `I have read the CLA Document and I hereby sign the CLA`. I gate, i comandi di test e le regole per le pull request sono in [CONTRIBUTING.md](CONTRIBUTING.md).

## Licenza

Dal port di upstream [7ac0ed7](https://github.com/sisyphuslabs/dori-superagent/commit/7ac0ed761dfb6aa0b3a81e8740a29cde5cbd0444), win-dori è sotto la [Sustainable Use License](LICENSE) versione 1.0, come upstream, con i componenti di terze parti sotto le loro licenze. Consente l'uso personale, l'uso interno aziendale e l'uso non commerciale gratuito; l'uso commerciale richiede una licenza dal titolare, Sisyphus Labs. [NOTICE.md](NOTICE.md) dice cosa ha modificato win-dori. Le versioni di win-dori fino a `fa86ddf` erano MIT e restano MIT. I prompt in `prompts/` sono le istruzioni che gli agenti ricevono davvero, e sono abbastanza brevi da leggerli prima di fidarti.
