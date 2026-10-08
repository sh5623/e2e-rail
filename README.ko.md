# e2e-rail

<div align="right">
  <a href="README.ko.md"><img src="https://img.shields.io/badge/lang-한국어-blue?style=flat-square" alt="한국어"/></a>
  <a href="README.md"><img src="https://img.shields.io/badge/lang-English-lightgrey?style=flat-square" alt="English"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License"/></a>
</div>

어느 프론트엔드 레포에나 붙는, 변경을 아는 Playwright E2E:

1. **고른다** — 변경이 닿을 수 있는 spec 만, 각각 근거와 함께. 판정할 수 없으면 전수로 넓힌다.
2. **남긴다** — 모든 실행을 «그 실행이 검증한 코드의 지문» 에 묶어 기록한다. «아까 통과했다» 는 가정하지 않고 확인한다.
3. **나눈다** — 머신당 무거운 실행 1개, 워커 수와 샤드는 측정값으로 정한다.

스크립트와 CI 가 부르는 의존성 0 의 Node CLI(`e2e-rail`)와, 에이전트가 그 CLI 를 정직하게 쓰도록 강제하는
**Claude Code** · **Codex** 스킬 층으로 이뤄진다. 선택·재실행·필터 실행을 전수 통과로 보고하지 않고, 선택 실행마다
근거가 담긴 선택 블록을 붙이고, 어떤 주장 전에도 `verify` 를 거친다.

**상태:** v0.2.1 (git 태그 `v0.2.1`). 호스트 레포에 Node ≥ 20, `@playwright/test` ≥ 1.56(선택·샤드 실행이
`--test-list` 를 쓰므로 더 낮으면 e2e-rail 이 거부한다), `typescript` ≥ 5 가 필요하다(번들하지 않고 빌려 쓴다).

## 설치

### CLI (모든 런타임과 CI)

```sh
pnpm add -D github:sh5623/e2e-rail#v0.2.1
```

스킬과 CI 는 항상 레포에 설치된 사본(`pnpm exec e2e-rail …`, npm·yarn 이면 `npx e2e-rail …`)을 부른다. 세션과 CI 가
같은 코어를 돌아야 원장이 서로 비교된다.

### Claude Code

```text
/plugin marketplace add sh5623/guardrail
/plugin install e2e-rail@guardrail
/reload-plugins
```

스킬 5개(`/e2e-rail:init`, `select`, `gate`, `measure`, `shadow`), 읽기 전용 에이전트 `e2e-impact-analyst`, 그리고
doctrine 을 주입하는 SessionStart 훅이 들어온다.

### Codex

```sh
codex plugin marketplace add https://github.com/sh5623/e2e-rail.git
codex plugin add e2e-rail@e2e-rail-codex
```

새 Codex 세션을 열고 `/hooks` 에서 SessionStart 명령(`cat "$PLUGIN_ROOT/hooks/doctrine.md"`)을 검토해 신뢰한다.
설치만으로는 훅이 신뢰되지 않는다. 같은 스킬 5개가 `$e2e-rail:init` … `$e2e-rail:shadow` 다. Codex 에는 에이전트가
없으므로 `select` 스킬이 `references/impact-analyst.md` 를 읽어 그 점검 목록을 직접 수행한다.

## 세팅

레포 하나에 약 30분.

1. `pnpm add -D github:sh5623/e2e-rail#v0.2.1`
2. Claude Code 또는 Codex 플러그인을 설치한다(위).
3. `init` 스킬을 돌린다. 손으로는 `pnpm exec e2e-rail init`: `e2e-rail.config.mjs` 를 쓰고(찾은
   `playwright.config.*` 마다 앱 하나), `paths` 를 가진 tsconfig 를 고르고, `.gitignore` 에 `.e2e-rail/`,
   `test-results/`, `playwright-report/`, `blob-report/` 를 더하고, 검토할 `package.json` 스크립트 3개를 출력한다.
4. `pnpm exec e2e-rail map --check`: verdict 가 가리키는 것을 고치고, unmapped spec 에 리터럴 라우트를 준다.
5. 전수 게이트를 `pnpm exec e2e-rail run --full` 로 바꾸고, 라운드마다 `shadow` 스킬로 마감한다.
   `shadow.promoteAfter` 회 연속 hit 이면 사람이 `shadow promote` 를 실행한다. 그 뒤로 개발 중에는 `select` 와
   `run --selection` 이 전수를 대신하고, 전수는 합본 단계로 옮겨 간다.

## 판정 방식

### 선택 규칙

`pnpm exec e2e-rail select --base <ref>` 는 `<ref>..HEAD` 를 diff 하고(로컬에선 미커밋·untracked 파일 포함,
`CI` 아래나 `--no-uncommitted` 면 제외) 변경 파일마다 처음 맞는 행으로 분류한다. 선택은 이름이 아니라 `<ref>` 가
가리킨 커밋을 저장하므로(머리 줄: `base <sha7> (<ref>)..HEAD`), 나중의 재선택은 HEAD 나 브랜치가 움직인 뒤에도 그
커밋에서 diff 한다. `--base last-green` 은 base 를 원장에서 가져온다: 현재 검증 정책(아래)으로 기록된, 깨끗한 트리에서
필터 없이 통과한 그 앱의 마지막 전수 실행(또는 완성된 샤드 세트)의 head 이며 모드는 가리지 않는다. 머리 줄이 그 실행을
밝힌다(`base <sha7> (last-green: run <id>, <mode>)..HEAD`). 그런 실행이 없으면 base 도 없다. `last-green` 은
키워드이므로, 이름이 정확히 `last-green` 인 브랜치나 태그는 그 SHA 로 넘긴다.

| # | 변경 파일 | 결과(이유) |
| --- | --- | --- |
| 1 | `ignore` 나 앱의 `tiers.ignore` 에 맞거나(`specDir` 아래 테스트 파일은 예외) 원장 디렉터리 안 | 무시 |
| 2 | `shared` 에 맞음 | 전 앱 전수(`shared:<file>`) |
| 3 | 어느 앱 root 에도 속하지 않거나 설정 root 밖 | 전 앱 전수(`unknown-root:<file>`) |
| 4 | 앱의 `tiers.full` 에 맞음(`supportDirs/**` 는 뺄 수 없고, Playwright 설정, `package.json` 과 함께 항상 포함) | 그 앱 전수(`tier-full:<glob>`) |
| 5 | `specDir` 의 테스트 파일(`*.spec.*` 또는 `*.test.*`) | 그 spec(`spec-self:<file>`). Playwright 가 나열하지 않아 인덱스가 모르는 파일이면 앱 전수(`spec-unindexed:<file>`) |
| 6 | `srcDir` 아래 | 닿는 spec(아래). 사각지대가 있으면 앱 전수 |
| 7 | 그 밖의 앱 파일 | 그 앱 전수(`app-other:<file>`) |
| – | base 없음(주지 않음, 커밋을 가리키지 않는 ref, 그런 통과가 없는 `last-green`), 또는 git 이 diff 를 못 냄 | 전 앱 전수(`no-base`) |
| – | `--head <ref>` 가 HEAD 가 아닌 커밋 | 전 앱 전수(`head-not-HEAD:<ref>`): 실행은 작업 트리를 시험하므로 `<ref>` 뒤의 커밋도 포함된다 |
| – | 미커밋 변경이 있는 트리에서 그것을 뺀 경우(`--no-uncommitted`, 또는 `CI` 아래) | 전 앱 전수(`uncommitted-excluded`): 실행은 그 변경도 시험한다 |

6행에서는 import 그래프가 변경 파일에서 위로 올라가 닿는 라우트 엔트리를 찾는다. spec 은 그 라우트가 닿은 라우트와
맞거나(`route:<route> ← <file>`), `page.route()` 목이 변경 파일의 API 리터럴과 맞거나(`api:<glob> ← <literal>`),
변경에 의존하는 코드를 import 하면(`import:<file>`) 선택된다. 모든 `unmapped` spec 과 `alwaysRun` spec 이 함께 탄다.
어댑터가 라우트 표를 못 읽거나(`adapter-unresolved:…`), 변경 파일이 그래프에 없거나 내부 import 가 하나라도 풀리지
않거나(`graph-unresolved:<file>`), 셸·스토어·레이아웃을 거쳐 앱 엔트리에 닿으면(`graph-shell:<file>`) 대신 앱 전수다.
**모름은 «변경 없음» 이 아니다. 넓힌다.** 종료 0 = 모든 앱 partial, 10 = 어느 앱이 전수.

### spec 인덱스와 라우트 엔트리

`map` 은 spec 마다(캐시 `.e2e-rail/map.<app>.json`) 라우트(`goto` 리터럴과 리터럴 접두를 가진 템플릿, `basePath` 제거),
API 글롭(`route()` 목), import 하는 소스 파일, support 헬퍼, Playwright 프로젝트(`playwright test --list` 기준)를
색인한다. spec 은 Playwright 가 나열하는 테스트 파일 그대로다. 이름(`*.spec.*`, `*.test.*`, 사용자 `testMatch`)이나
`tiers.ignore` 와 상관없고, 나열되지 않는 파일은 돌 프로젝트가 없으니 색인하지 않는다. spec 이 import 하는 support
헬퍼 안의 리터럴 `goto` 는 그 spec 의 라우트에 합쳐지지만, 자기 navigation 을 읽을 수 없는 spec 을 구해 주지는
않는다. 그런 spec 은 **unmapped** 이고 모든 src 변경마다 돈다. unmapped 비율이 선택이 아낄 수 있는 상한이다.

`react-router-lazy` 어댑터는 `adapter.routeFiles` 에서 `path` + lazy `import()` 쌍을 읽는다. 리프는 정확한 경로로,
`children` 을 가진 라우트는 레이아웃이라 그 모듈을 `<path>/*`(루트 레이아웃은 `*`)로 매핑한다. 레이아웃은 아래의 모든
라우트에 영향을 주기 때문이다. `manual` 어댑터는 `adapter.map` 을 받는다. 어느 어댑터든 `adapter.routeFiles` 가
라우트 표 파일을 나열할 때만 좁힌다. 그 파일이 위로 오르기를 멈추게 하고, 없으면 모든 페이지가 라우터를 거쳐 앱
엔트리에 닿는다. 엔트리는 `src/main.*` 또는 `src/index.*`, 지정하면 `main` 이다.

### 지문 · 원장 · verify

실행마다 지문을 남긴다: `head`, 미커밋 `diff` 해시, `untracked` 파일 해시(원장 디렉터리 제외), 두 설정의 해시,
Playwright 버전, preview 모드면 빌드된 `dist` 해시. `id` 는 그 전부이고, `codeId` 는 head·diff·untracked 로 선택과
실행을 짝짓는다. `clean`(`id` 에는 들어가지 않는다)은 작업 트리가 HEAD 그 자체였는지, 즉 추적 파일 변경도 원장 디렉터리
밖의 untracked(무시되지 않은) 파일도 없었는지를 말한다. `.e2e-rail/ledger.jsonl` 에는 실행 1회가 append-only 한 줄로
남는다: `policy`, `kind`(`full` · `selected` · `rerun` · `shard`), `mode`, 지문, `testListSha`(읽은 test list 의
sha256), shard, workers, `filtered`, `shadowed`, 락 시각, rc, spec 별 결과, 실패, flaky. 깨끗한 트리에서 필터 없이
통과한 전수 실행(또는 깨끗한 트리에서 돈 샤드로 `complete: yes` 를 찍은 `shard merge`)이 `select --base last-green` 이
diff 하는 출발점이다. 그 실행은 자기 head 를 `.e2e-rail/last-green.<app>` 에도 쓰지만 참고용일 뿐이다: e2e-rail 이
안내하는 어떤 것도 더는 그 파일을 읽지 않는다(0.1.0 은 미커밋·완화 통과에도 그 파일을 썼고, 맨 sha 한 줄로는 어느 것인지
알 수 없다). 미커밋 변경이 있는 상태의 통과는 정확히 그 코드만 검증할 뿐 HEAD 를 검증하지 않는다:
`last-green not moved: the working tree had uncommitted changes` 를 찍고, `verify` 도 `--base last-green` 도 그 head 를
base 로 내놓지 않는다.

`policy` 는 그 줄이 기록된 검증 정책이다(0.2.1 부터 2. 무엇을 검증으로 치는지가 바뀔 때만 오른다). `verify`,
`shadow record`, `shard merge`, `select --base last-green` 은 현재 정책의 줄만 센다. 지문은 e2e-rail 자신의 규칙을
담지 않기 때문이다: `--ignore-snapshots` 통과를 필터 없음으로 기록한 0.1.0 줄도 자기 코드와는 여전히 맞는다. 이 코드와
맞는 것이 그런 줄뿐이면 `verify` 는
`stale: run <id> was recorded under an older e2e-rail verification policy (<n|none> < 2); run it again` 을 찍는다
(`--json`: `rejected: { runId, why: 'policy' }`). 그래서 e2e-rail 을 올리면 이전 줄은 한 번 무효가 된다: 전수를 다시
돌려라. `measure` 와 `shard plan` 은 그 줄의 소요 시간을 계속 쓴다.

`verify` 는 원장으로 «정확히 이 코드가 통과했는가» 에 답한다. 이 앱 · 이 모드 · 이 지문 · 통과 · 필터 없음인 실행만
센다. `--require full` 은 전수 실행이나 완성된 샤드 세트를, `--require selected` 는 `run --selection` 으로 만든 선택
실행까지 받는다(`verified: selected@<run-id> (selection <id>[, shadowed]) (<age>)` 를 찍는다). 단 그 실행의
`selections/<id>.json` 이 남아 있고, 실행이 시험한 코드에 대해 계산됐으며, 그 head 가 실행이 시험한 커밋이고, 실행이
읽은 목록을 지금도 그대로 써야
한다(실행 뒤 `select --add` 를 했으면 다시 돌려야 한다). 임의의 `--test-list`
실행과 `measure workers` 실행은 세지 않는다. 재실행은 절대 세지 않는다. preview 모드는 dist 가 없거나 낡았으면(git 이 아는 어떤 파일보다 오래됨) 먼저 다시 빌드하고,
`--no-build` 면 대신 거부한다.

## 명령

| 명령 | 옵션 | 출력 · 종료 |
| --- | --- | --- |
| `init` | `--force` | `e2e-rail.config.mjs` 작성 · `.gitignore` 줄 · 제안 스크립트 · 0 |
| `map` | `--app <name>` · `--check` · `--explain <spec>` | `app <name>: <n> specs indexed · …` · `--check` 면 `graph:`, `verdict:`, `unmapped: <u>/<n> (<p>%)` · 0 |
| `select` | `--app <name>` · `--base <ref>`(또는 `last-green`) · `--head <ref>` · `--no-uncommitted` · `--json` · `--add <spec>` · `--remove <spec>` · `--reason <text>` | 표 `app  mode  specs  unmapped  reasons` · `selection.json` · `test-list.<app>.txt` · 0 partial · 10 full |
| `run` | `--app <name>` · `--full` · `--selection [id]` · `--test-list <file>` · `--last-failed` · `--mode dev\|preview` · `--workers N` · `--project <name>` · `--shard i/n` · `--blob` · `--no-lock` · `--no-build` · `-- <playwright args>` | `run-id <id> · kind <kind> · rc <rc> · <ms>ms · failures <n>` · `failed:` 줄 · `filtered: …` · `shadowed: …` · Playwright 종료 코드(test list 가 아무것도 맞히지 못하면 1) |
| `verify` | `--app <name>` · `--mode dev\|preview` · `--require full\|selected` · `--max-age <min>` · `--json` | `verified: …` 0 · `stale: …` 20 · `insufficient: …` 21 |
| `shadow` | `record --run <run-id> [--app <name>]` · `status` · `promote` · `demote` | `shadow: <run-id> hit\|miss\|trivial\|unpaired · streak <s>/<n>` · `trust <t> · streak <s>/<n> · promotable <yes\|no>` · 0 |
| `measure` | `--app <name>` · `slowest [-n N]` · `retries [--last N]` · `workers <1,2,4> --test-list <file> [--mode dev\|preview]` | 표 · 0 |
| `shard` | `--app <name>` · `plan --count N [--from-run <run-id>] [--include <spec>] [--mode dev\|preview]` · `merge --dir <blob dir> [--mode dev\|preview]` | `manifest:` 와 `shard <i>/<n>` 줄 · `merge: rc <rc> · html … · complete: yes\|no` · merge-reports 종료 코드 |
| `lock` | `status` · `reap` · `run <heavy\|light> -- <command…>` | 보유자 · 지운 락 · 명령의 종료 코드(시작 못 하면 127) |

공통: `--version`, `--help`, `<command> --help`. 모든 오류는 stderr 의 `e2e-rail: <message>` 한 줄이고, 사용법 오류는
2, 그 밖은 1 로 끝난다. 실행 모양을 바꾸는 옵션은 CLI 자체 플래그다. `--` 뒤의 `--shard`, `--test-list`,
`--test-list-invert`, `--last-failed`, `--last-failed-file`, `--list`, `--only-changed`, `--reporter`, `--output`,
`-c`, `--config`, `--ui`, `--debug`, `--run-agents` 는 실행 전에 거부된다. `--` 뒤에서 실행을 그 kind 그대로 두는 것은
`--headed`, `--quiet`, `--trace <mode>`, `--repeat-each <n>`, `--fail-on-flaky-tests`, `--forbid-only`,
`--fully-parallel`, `--max-failures <n>`, `-x`, `-j`/`--workers <n>` 뿐이다. 그 밖의 모든 인자 — 테스트 필터(`-g`,
`-G`, `--grep`, `--grep-invert`, `--project`, 파일), 검사를 건너뛰거나 느슨하게 하는 옵션(`--ignore-snapshots`, `-u`,
`--retries`, `--timeout`, `--no-deps`, `--pass-with-no-tests` 등), e2e-rail 이 모르는 옵션 — 은 `--project` 와 같이
실행을 filtered 로 만든다. 그 실행은 `kind full (filtered)` 와
`filtered: <options> narrow or relax the run; not a verification` 를 찍고, 검증도 last-green 이동도 하지 않는다.
그 앱의 test-list 줄을 하나도 쓰지 않는 선택으로 `run --selection` 을 하면
`<app>: nothing selected (partial, 0 specs)`(선택된 spec 에 Playwright 프로젝트가 없으면 `…, <n> spec(s), 0 test-list lines`)를
찍고 아무것도 돌리거나 기록하지 않는다. test list(선택, 샤드 계획, `--test-list <file>`)로 돈 실행에서 목록이 어떤
테스트와도 맞지 않으면 Playwright 는 0 으로 끝나지만 실패로 기록된다(rc 1, `failed: test list matched no tests`). 맞는
테스트가 없는 줄이 하나라도 있어도 그렇다(`failed: test list line matched no tests: <line>`). 단 일부러 좁힌(filtered)
실행은 줄 검사를 하지 않는다. `--test-list` 의 줄을 테스트의 제목 경로 전체로만 맞추는 Playwright 1.56–1.57 에서는
e2e-rail 이 먼저 테스트를 나열해, 목록이 덮는 테스트마다 그런 줄 하나씩을 Playwright 에 넘긴다
(`.e2e-rail/reports/<run-id>.test-list.txt`, 실행 뒤 삭제). 목록 자체와 위의 검사는 쓰인 그대로다. `run --selection` 은
선택이 다른 코드에 대해 계산됐거나(`select` 뒤에 파일이 바뀜: `selection <old> was for other code — reselected as <new>`),
HEAD 가 아닌 head 까지로 만들어졌거나(`selection <old> was made up to <head>, not HEAD — reselected as <new>`), 미커밋
변경이 있는 트리에서 그것을 뺐으면(`selection <old> left out uncommitted work in a tree that is not clean — reselected as <new>`)
같은 base · 미커밋 포함 여부로 HEAD 까지 선택을 다시 계산해(`--add` 는 옮겨 오고 `--remove` 는 옮겨 오지 않는다) 새 선택을 돌린다. 새 선택은 실행이 현재 선택을 썼을 때만
현재 선택이 된다(다른 선택을 `run --selection <id>` 로 돌리면 `selections/<new>.json` 만 쓴다). 같은 base 란 선택이
저장한 커밋이다. 0.2.0 이하가 쓴 선택은 받은 이름(`HEAD`, 브랜치)을 그대로 저장했고 그 이름은 지금쯤 더 새 커밋을
가리킬 수 있으므로, base 없이 전수로 다시 선택한다
(`selection <old> stored its base by name ("<ref>"), which may have moved — reselected in full`). 선택 실행은 자기만의 목록
파일(`.e2e-rail/reports/<selection>.<app>.<pid>.test-list.txt`, 실행 뒤 삭제)을 Playwright 에 넘긴다. 락을 기다리는 동안 코드가 바뀌면
`the code changed while waiting for the lock (selection <id> no longer matches); run it again` 으로 멈추고 아무것도
기록하지 않는다.

## 섀도 모드

선택기는 전수를 대신하기 전에 신뢰를 얻어야 한다. `.e2e-rail/state.json` 은 `trust shadow` 로 시작한다. 그동안 모든
선택 실행은 `shadowed` 로 기록·출력되고 `select --remove` 는 거부된다.

라운드 마감: 합본 전수가 검증할 바로 그 코드에서 `select` 를 계산하고, 전수를 돌리고,
`pnpm exec e2e-rail shadow record --app <app> --run <run-id>` 를 실행한다. 실행은 같은 `codeId` 의 선택과 짝지어진다.
`hit`(실패한 spec 이 모두 선택 안에 있음 · 통과한 실행도 hit)은 streak 를 1 올리고, `miss` 는 0 으로 되돌리며 놓친
spec 을 적는다. `trivial`(선택이 전수)과 `unpaired`(이 코드의 선택 없음)는 streak 를 건드리지 않는다. 필터·재실행·선택·
샤드 실행, 실패했는데 기록된 실패가 없는 실행, 그리고 이전 검증 정책으로 기록된 실행
(`… was recorded under an older e2e-rail verification policy …`)은 거부된다. `shadow status` 가 `promotable yes` 를 찍으면 사람이
`shadow promote` 를 실행할 수 있다. 자동 승격은 없다. `shadow demote` 는 streak 0 으로 섀도에 되돌린다. 이전 검증
정책으로 쓰인 `state.json` 은 streak 0 · 기록 없음으로 읽히고(trust 는 유지), 다음 `shadow record` 전까지
`shadow status` 가 `streak reset: earlier records were made under an older verification policy` 를 찍는다. 섀도 비용은
0 이다. 전수는 어차피 돈다.

### 씨앗 실패 훈련 (seeded-failure drill)

streak 는 선택이 잡아낸 것을 셀 뿐이고, 훈련은 선택이 진짜 고장을 잡는지 보여 준다. 섀도 기간에 임시 브랜치
(`git switch -c e2e-drill`)에서 최근 변경 하나를 골라, 그 변경이 건드리는 코드를 일부러 망가뜨려 선택돼야 할 spec 이
실패하게 만든다. `select --app <app> --base <base>` 를 돌려 그 spec 이 고장 낸 파일을 가리키는 근거와 함께 선택에
들어 있는지 확인하고, `run --app <app> --selection` 이 실패하는지 본다. 그 spec 이 빠진 선택이나 통과한 실행은 섀도
miss 처럼 고칠 선택기의 놓침이다. 관계없는(UNRELATED) spec 에도 실패를 하나 심는다: 전수는 실패하고, 선택과 짝지으면
miss 로 보인다. 예상된 결과다. miss 가 streak 를 되돌리는 것은 실패가 진짜일 때뿐이므로, 훈련의 전수 실행은 절대
`shadow record` 로 기록하지 않는다. 끝나면 revert 한다: 임시 브랜치에서 나와 그 브랜치를 지운다.

## 락 · 워커 · 분산

**락.** 락 하나가 머신 전체(모든 레포와 워크트리)를 맡는다. 임시 디렉터리 아래의 0700 개인 디렉터리에 있고
`E2E_RAIL_LOCK_DIR` 로 옮긴다. 전수·샤드 실행, 워커 수 없는 실행, `measure workers` 는 배타적인 heavy 락을 잡고, 나머지는
light 두 자리를 나눠 쓴다. 기다리는 heavy 가 있으면 새 light 는 들어가지 못한다. `pnpm exec e2e-rail lock status` 는
보유자를, `lock reap` 은 프로세스가 사라진 락을 지우고, `lock run heavy -- <command>` 는 다른 명령을 같은 락으로 감싼다.

**워커.** e2e-rail 은 워커 수를 정하지 않는다. `pnpm exec e2e-rail measure workers 1,2,4 --test-list <file>` 이
같은 목록을 워커 수마다 한 번씩, 매번 배타 락 아래서 돌리고 벽시계·실패·재시도·부하를 출력한다. 이긴 값은 사람이
`run.workers`(`local`, `ci` · CI 기본 1)에 쓴다.

**분산.** 네이티브: 잡마다 `pnpm exec e2e-rail run --app <app> --full --shard <i>/<n> --blob`. 계획 분할:
`pnpm exec e2e-rail shard plan --app <app> --count <n>` 이 지금 Playwright 가 나열하는 테스트를 측정 시간으로(긴 것부터
가장 가벼운 샤드에, 시간 없는 spec 은 중앙값) `.e2e-rail/shards/<app>/<i>.txt` 와 목록별 sha256 을 담은
`manifest.json` 으로 나누고, 잡마다
`run --test-list .e2e-rail/shards/<app>/<i>.txt --shard <i>/<n>` 를 돌린다. 다른 번호·개수로, 고쳐서, 또는 다른 앱의
계획으로 돌리면 거부된다. `shard merge --dir <blob dir>` 는 blob 리포트를 HTML 하나로 합치고, 한 분할의 모든 샤드가
정확히 이 코드에서 통과했을 때만 `complete: yes` 를 찍는다. 같은 `n` 의 네이티브 `i/n` 전부, 또는 이 코드로 만든 계획
하나의 목록 전부다. 그때만 `verify` 가 그 세트를 전수로 센다.

## CI 템플릿

`templates/ci/` 에 있다(복사해서 쓴다. e2e-rail 이 설치하지 않는다).

- `github-actions-shard.yml` — 한 번 빌드, 네이티브 샤드 matrix(`run --full --shard <i>/<n> --blob`), 그리고 샤드의
  원장 줄을 이어 붙여 `shard merge` 와 `verify --require full` 을 돌리는 merge 잡. 주석으로 된 변형은 별도 잡에서 샤드를
  계획하고 `.e2e-rail/shards/<app>/` 를 matrix 에 넘긴다.
- `codebuild-batch.yml` — 같은 모양의 CodeBuild batch `build-graph`. dist · blob 리포트 · 원장 줄을 S3 로 넘긴다.
- `buildspec-snippet.yml` — 섀도 기간 게이트: `select --base last-green`(또는 `$E2E_BASE`), 이어서
  `run --full --mode preview`, 이어서 요약 줄에서 뽑은 run id 로 `shadow record --run <run-id>`. `.e2e-rail/` 는 빌드
  캐시에 남긴다.

작업 트리에 내려받은 파일은 지문을 바꾸므로, 템플릿은 내려받기를 `$RUNNER_TEMP` 나 임시 디렉터리에, 원장 줄은 지문이
무시하는 `.e2e-rail/` 에 둔다.

## 설정

레포 루트의 `e2e-rail.config.mjs`. 따로 적지 않은 경로는 앱 root 기준이고, 모르는 키는 경고만 한다.

| 키 | 기본값 | 뜻 |
| --- | --- | --- |
| `apps[].name` · `root` · `playwrightConfig` | 필수 | 앱 이름, 디렉터리(레포 기준), Playwright 설정(실재해야 함) |
| `specDir` · `supportDirs` | `e2e` · `[<specDir>/support]` | spec, spec 이 import 하는 헬퍼(여기 변경은 앱 전수) |
| `srcDir` · `tsconfig` · `main` | `src` · `tsconfig.json` · 탐지 | 소스 root, 별칭을 푸는 `paths` 의 tsconfig, `src/main.*`·`src/index.*` 가 아닐 때의 앱 엔트리 |
| `adapter.name` | 필수 | `react-router-lazy` 또는 `manual` |
| `adapter.routeFiles` · `basePath` · `map` | `[]` · `''` · `{}` | 라우트 표 글롭(좁히려면 필요), 라우터가 붙이는 접두, `manual` 용 `{ '<route>': ['src/…'] }` |
| `apiPrefix` · `alwaysRun` | `/api` · `[]` | 소스 리터럴에서 읽는 API URL 접두, 모든 선택에 들어가는 spec slug |
| `tiers.full` · `tiers.ignore` | support 디렉터리, Playwright 설정, `package.json` · `srcDir` 아래 단위 테스트(`<srcDir>/**/*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`)와 `**/*.md` | 앱 전수로 만드는 글롭 · 실행을 일으키지 않는 글롭(`specDir` 아래 테스트 파일은 무시되지 않는다. Playwright 는 `*.test.*` 도 돌린다) |
| `run.preview` | 없음 | `--mode preview` 용 `{ build: '<command>', dist: '<dir>' }` |
| `run.workers` · `run.modeEnv` · `run.env` · `run.port` | `{ ci: 1 }` · `{}` · `{}` · 없음 | 측정한 워커 수, 모드별 env, 모든 실행의 env(e2e-rail 은 주입하지 않는다), 참고용 |
| `shared` · `ignore` | `[]` · `['**/*.md', 'docs/**']` | 전 앱 전수로 만드는 레포 기준 글롭 · 실행을 일으키지 않는 글롭 |
| `shadow.promoteAfter` · `ledger.dir` | `3` · `.e2e-rail` | `promotable yes` 까지의 연속 hit 수, 원장 디렉터리(gitignore) |

실제 도입한 모노레포 앱(라우트 엔트리 184개, unresolved 0):

```js
export default {
  apps: [
    {
      name: 'bfm',
      root: 'apps/bfm',
      playwrightConfig: 'playwright.config.ts',
      tsconfig: 'tsconfig.app.json',            // the referenced config with `paths`; tsconfig.json is solution-style
      adapter: {
        name: 'react-router-lazy',
        routeFiles: ['src/features/**/routes.tsx', 'src/routes/router.tsx'],
        basePath: '/app',
      },
      tiers: {
        full: ['src/routes/**', 'src/components/layout/**', 'src/stores/**', 'src/lib/api/**'],
      },
      run: {
        preview: { build: 'pnpm -F bfm build', dist: 'dist' },
        modeEnv: { preview: { E2E_PREVIEW: '1' } },
      },
    },
  ],
  shared: ['packages/**', 'pnpm-lock.yaml', 'tsconfig*.json'],
};
```

## 한계

정적 분석은 아래 경우에 여전히 잘못 좁힐 수 있다. 각각 완화책이 있고, 누군가 선택을 믿기 전에 섀도 모드가 새어 나간
것을 센다.

- **런타임 문자열 이동과 클릭으로만 가는 흐름**(`navigate('/x')`, 클릭으로만 닿는 페이지): import 그래프가 따라가지
  못한다. 셸과 라우터를 `tiers.full` 에 넣고, impact-analyst 점검 목록이 이를 찾는다.
- **`import.meta.glob(…, { base })` 와 `(import.meta as any).glob`**: 간선으로 풀리지 않는다. 글롭을 쓰는 모듈의
  디렉터리를 `tiers.full` 에 넣는다. impact-analyst 점검 목록도 묻는다.
- **tsconfig `paths` 에 대응이 없는 Vite `resolve.alias`**: 그 별칭을 거친 import 가 보이지 않는다. 모든 별칭을
  `paths` 에도 둔다. impact-analyst 점검 목록도 묻는다.
- **헬퍼 호출로 만든 라우트 배열**과 **`errorElement` 로 쓰인 모듈**: 어댑터가 라우트 엔트리로 읽지 못할 수 있다.
  그 파일을 `tiers.full` 에 둔다.
- **URL 꼬리만 제한하는 API 글롭**(`**/items`): 꼬리가 동적인 소스 리터럴(`/api/orders/${id}/items` 는
  `/api/orders/*` 로 읽힌다)과는 맞춰 보지 않으므로, 꼬리만 목으로 잡는 spec 은 API 축으로 선택되지 않는다. 목 글롭에
  경로 접두를 쓴다(`**/api/orders/**`). impact-analyst 가 서비스와 그 목을 점검한다.
- **gitignore 된 빌드 입력**(예: `.env.local`)과 **이미 커밋된 삭제**는 `dist` 를 낡게 만들지 않는다. 그것을 바꾼
  뒤에는 다시 빌드하거나 `dist` 를 지워 preview 모드가 다시 빌드하게 한다.
- **env 로 고르는 프로젝트**: spec 인덱스는 dev 환경(`run.env` + `run.modeEnv.dev`)에서 테스트를 나열한다. 프로젝트나
  `testDir` 가 env(예: `run.modeEnv.preview`)에 따라 달라지는 Playwright 설정은 preview 에서 다른 프로젝트를 나열할 수
  있어서, `--mode preview` 로 돌리는 선택이 preview 전용 프로젝트를 놓칠 수 있다(preview 에 없는 프로젝트의 줄은 대신
  실행을 실패시킨다). `shard plan --mode preview` 는 preview 환경에서 나열한다. 프로젝트 구성을 모드와 무관하게 두거나,
  preview 게이트는 `run --full` 로 돌린다.
- **`--base last-green` 은 모드를 가리지 않고(ANY mode) 가장 최근의 깨끗한 전수 통과를 고른다**: dev 에서는 통과했지만
  preview 에서는 실패할 커밋이 `--mode preview` 로 돌릴 선택의 base 가 될 수 있다. 머리 줄이 그 실행과 모드를 밝힌다
  (`base <sha7> (last-green: run <id>, <mode>)`). preview 에서 검증된 커밋에서 diff 하려면 그 커밋의 SHA 를 넘긴다
  (`verify --mode preview` 가 `last verified head` 로 찍는다).

아래 모양은 잘못 좁히지는 않지만 늘 앱 전수로 돈다(샘플 앱에서 실측).

- **`export default [...]` 로 쓰고 다른 라우트 파일에서 펼친 라우트 표**
  (`import cartRoutes from './routes'` … `children: [...cartRoutes]`): 어댑터는 `const` 배열만 따라간다.
  `map --check` 는 `! src/router.ts:6: spread of 'cartRoutes' is not a const array literal declared in this file or
  in a file routeFiles covers (imported from '@/features/cart/routes')` 와
  `verdict: every src change will run full: the react-router-lazy adapter could not read 1 route definition(s) …` 를
  찍고, `select` 는 `adapter-unresolved:…` 를 찍는다. `export const cartRoutes = [...]` 로 내보낸다.
- **페이지가 로컬 `lazy()` 상수나 화살표 함수인 리프**: `const Page = lazy(() => import('./Page'))` 를
  `Component: Page` 나 `element: <Page />` 로 쓰거나 `Component: () => <Page …/>` 를 쓴 경우. 그 라우트는 엔트리가
  없다. `map --check` 는 `!` 줄을 찍지 않고(`route entries` 수가 라우트보다 하나 적고, verdict 는 여전히
  `narrowing possible` 일 수 있다), 그 페이지를 고치면 라우트 표를 거쳐 앱 엔트리에 닿아 `select` 가
  `graph-shell:<page file>` 을 찍는다. 라우트의 `lazy` 필드나 import 한 페이지를 쓴 `Component:` 를 쓴다.
- **`srcDir` 아래의 코드 아닌 파일**(`.css`, `.svg`, `.json` 등): import 그래프에 없다. `map --check` 는 아무 말도
  하지 않고, 고치면 `select` 가 `graph-unresolved:<file>` 을 찍는다.

지문의 `config` 필드는 `e2e-rail.config.mjs` 와 앱의 Playwright 설정만 해시하고, `playwright.config.ts` 가 import 하는
로컬 모듈은 넣지 않는다. 그런 모듈을 고치면 `head`, `diff`, `untracked` 중 하나는 여전히 움직인다(`verify` 는 stale 이고
`differing` 은 `config` 가 아니라 그것을 가리킨다). 설정이 읽는 gitignore 된 파일(예: env 파일)은 전혀 덮지 않는다.
`verify` 가 볼 수 없으니 그 파일을 바꾼 뒤에는 스위트를 다시 돌린다.

Playwright 1.56–1.57 에서는 `--test-list` 줄이 테스트의 제목 경로 전체를 적어야 하는데, `›` 나 줄바꿈이 들어 있거나,
앞뒤에 공백 문자(whitespace)가 있거나, 빈 제목은 줄로 적을 수 없다. 그런 테스트가 있는 spec 은 목록으로는 절대 돌지 않는다: 그 spec 의 선택 실행은
매번 실패하고(`failed: test list line matched no tests: <line>`), 그것을 담은 샤드 계획은 완성되지 않는다. 줄이 파일을
가리킬 수 있는 Playwright ≥ 1.58 을 쓰거나 테스트 이름을 바꾼다.

## 플러그인 층

| 스킬 | 언제 | 무엇을 강제하나 |
| --- | --- | --- |
| `e2e-rail:init` | e2e-rail 이 없는 레포 | 설치, `init`, 설정 검토, `map --check`, unmapped 비율 |
| `e2e-rail:select` | 변경에 E2E 를 돌리기 전 | `select`, impact-analyst 점검, `--add` 와 `--reason`, 선택 블록 |
| `e2e-rail:gate` | 돌리고 보고할 때 | `run` 다음 같은 모드의 `verify`, 고정 보고 형식, 재실행·필터 실행은 절대 전수 통과가 아님 |
| `e2e-rail:measure` | 느리거나 흔들리는 스위트 | 느린 spec·재시도, trace 분해, `measure workers`, 그다음 샤드 |
| `e2e-rail:shadow` | 라운드 마감 | `shadow record`, `shadow status`, 승격은 사람에게 제안할 뿐 자동이 아님 |

선택 실행마다 붙는 선택 블록:

```text
change:   order search filter (src/features/orders/OrderSearchFilter.tsx +2 more)
selected: orders · order-detail (reasons: route:orders ← OrdersPage.tsx · api:**/api/orders/** ← /api/orders/list)
added:    none      removed: none
mobile:   orders
unmapped: 1 (map --check lists them)
final:    full run in the integration step · trust shadow
```

`e2e-impact-analyst`(Claude Code, 읽기 전용: Read, Grep, Glob, Bash)는 그래프가 못 보는 것 — 문자열 이동, 모달
오프너, API 리터럴 없는 서비스, `supportDirs` 밖 픽스처, 런타임 라우트, URL 상태, 모바일 분기 — 을 점검하고 근거와 함께
`--add` 후보만 돌려준다. 삭제는 제안하지 않는다. Codex 는 같은 점검 목록을 `references/impact-analyst.md` 에서 읽어
수행한다. SessionStart doctrine(`hooks/doctrine.md`)이 여섯 규칙을 모든 세션에 둔다.

## 개발

```sh
npm test               # node:test, no dependencies; includes the plugin-layer checks
npm run test:contract  # against real Playwright (E2E_RAIL_CONTRACT=1)
npm run sync:codex     # mirror skills/, references/ and hooks/doctrine.md into plugins/e2e-rail/
```

`skills/` 가 정본이고 Codex 패키지 사본은 그와 같아야 한다(다르면 테스트가 실패한다). 설계와 계획은
`docs/superpowers/` 에 있다.

## 라이선스

MIT © 2026 Seungho
