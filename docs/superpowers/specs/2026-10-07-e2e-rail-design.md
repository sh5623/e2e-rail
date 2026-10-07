# e2e-rail 설계 스펙 (2026-10-07)

> Playwright E2E 를 «변경에 맞게 고르고 · 부하와 머신에 맞게 나누고 · 무엇을 검증했는지 남기는» Claude Code 플러그인 겸 npm CLI.
> 상태: 설계 확정 · 구현 전. 구현 계획은 `docs/superpowers/plans/2026-10-07-e2e-rail-implementation.md`.

## 0. 한 줄 요약과 범위

**목표**: 어느 프론트엔드 레포든 설치만 하면 다음 셋을 얻는다.

1. **선택** — 변경 파일에서 영향받는 spec 만 골라 `--test-list` 로 넘긴다. 못 고르면 전수로 넓힌다.
2. **원장** — 어떤 코드 상태(커밋 + 미커밋 + 빌드 산출물)에서 무엇을 어떤 모드로 돌려 어떤 결과가 났는지 남긴다. 낡은 초록을 재사용하지 못하게 한다.
3. **분산·부하** — 측정값으로 워커 수를 정하고, 무거운 실행은 머신당 1개만 돌리며, Playwright 네이티브 `--shard` 로 여러 CI 잡에 나눈다.

**범위 밖(v1)**: Cypress 등 다른 러너 · AI 가 테스트를 쓰는 기능(tester-army/e2e 류) · 시각 회귀 · 테스트 생성 · 커버리지 기반 선택(v2 후보).

**원칙**
- 바퀴 재발명 금지. `--test-list` · `--test-list-invert` · `--last-failed` · `--shard` · blob 리포터 · `merge-reports` 는 Playwright 것을 호출만 한다.
- **좁혀서 틀리지 않는다.** 판정 불가는 항상 «넓힘(전수)» 으로 떨어진다. 선택기가 틀리는 방향은 «너무 많이 돌림» 뿐이어야 한다.
- **에이전트는 판단, 스크립트는 보장.** 영향 분석 근거는 에이전트가 쓰고, 실행 범위·기록·보고 형식은 스크립트가 강제한다.
- 의존성 0. node 내장 모듈만 쓰고, `typescript` 와 `@playwright/test` 는 호스트 레포 것을 peer 로 빌린다.

## 1. 배포 형태

하나의 GitHub 레포 `sh5623/e2e-rail` 이 세 얼굴을 갖는다. **코어는 에이전트 런타임에 종속되지 않는다.**

| 얼굴 | 설치 | 쓰는 쪽 |
| --- | --- | --- |
| npm 패키지(`bin: e2e-rail`) | `pnpm add -D github:sh5623/e2e-rail#v0.1.0` | 레포의 `package.json` 스크립트 · CI(buildspec · GitHub Actions). 에이전트 없이 돈다 |
| Claude Code 플러그인(레포 루트) | `/plugin marketplace add sh5623/guardrail` → `/plugin install e2e-rail@guardrail` | Claude 세션. 스킬 5 · 에이전트 1 · SessionStart 훅 |
| Codex 플러그인(`plugins/e2e-rail/`) | `codex plugin marketplace add https://github.com/sh5623/e2e-rail.git` → `codex plugin add e2e-rail@e2e-rail-codex` | Codex 세션. 같은 스킬 5(`$e2e-rail:<skill>`) · SessionStart 훅. 에이전트는 없으므로 `references/impact-analyst.md` 를 스킬이 직접 읽는다 |

런타임 층은 self-improvement 공개판(v0.7.0)과 같은 레이아웃을 쓴다: 루트 `.claude-plugin/plugin.json` + `skills/` + `agents/` + `hooks/`, Codex 는 `.agents/plugins/marketplace.json`(source local `./plugins/e2e-rail`) + `plugins/e2e-rail/.codex-plugin/plugin.json` + `skills/` + `hooks/`. **스킬 본문은 루트 `skills/` 가 정본**이고 `scripts/sync-codex.mjs` 가 Codex 패키지로 복사한다. 테스트가 두 벌의 동일성을 검사한다(드리프트 방지).

스킬은 항상 `pnpm exec e2e-rail …`(레포에 설치된 bin)을 호출한다. 플러그인 안의 복사본을 직접 실행하지 않는다. 이유: 세션과 CI 가 **같은 버전의 같은 코어**를 돌아야 원장이 비교 가능하다. 레포에 설치돼 있지 않으면 스킬 `init` 이 설치부터 안내한다. 스킬 본문의 런타임 분기는 «Claude 면 에이전트 위임 · Codex 면 참조 문서 읽기» 한 줄뿐이다.

`guardrail` 마켓 등재는 플러그인 v0.1.0 태그 뒤에 `marketplace.json` 에 항목 1개를 추가한다(계획서 마지막 태스크).

**설치 후 세팅 순서(레포 1개 · 약 30분)**
1. `pnpm add -D github:sh5623/e2e-rail#v0.1.0`
2. Claude `/plugin install e2e-rail@guardrail` 또는 Codex `codex plugin add e2e-rail@e2e-rail-codex`
3. `init` 스킬: 설정 파일 생성 · playwright config 탐지 · `.gitignore` · `package.json` 스크립트 제안
4. `pnpm exec e2e-rail map --check`: unmapped 비율 확인 → 해당 spec 에 리터럴 경로 상수
5. 전수 게이트를 `run --full` 로 교체 · 라운드마다 `shadow` 스킬 → 연속 3회 누락 0 이면 `shadow promote` → 개발 중 `select` + `run --selection`

## 2. 레포 구조

```
e2e-rail/
├── .claude-plugin/plugin.json        # name e2e-rail · version · author
├── package.json                      # name e2e-rail · type module · bin · engines node>=20 · files · peerDependencies(optional)
├── bin/e2e-rail.mjs                  # CLI 진입(디스패처만)
├── src/
│   ├── cli.mjs                       # 인자 파싱 · 서브커맨드 라우팅 · 종료 코드
│   ├── config.mjs                    # e2e-rail.config.mjs 로드 · 기본값 · 검증
│   ├── spec-index.mjs                # spec → {routes, apis, imports, projects}
│   ├── graph.mjs                     # TypeScript 역방향 import 그래프 + 캐시
│   ├── adapters/
│   │   ├── index.mjs                 # 어댑터 레지스트리 · 공통 인터페이스
│   │   ├── react-router-lazy.mjs     # routes.tsx 의 path + lazy import 파서
│   │   └── manual.mjs                # 설정 파일의 손 매핑
│   ├── select.mjs                    # 변경 파일 → 선택 결과 + test-list
│   ├── fingerprint.mjs               # 코드 상태 지문
│   ├── ledger.mjs                    # .e2e-rail/ledger.jsonl 읽기·쓰기·조회
│   ├── run.mjs                       # playwright test 래퍼(지문·락·리포터·원장)
│   ├── verify.mjs                    # 현재 지문이 검증됐는가
│   ├── shadow.mjs                    # 섀도 대조·승격
│   ├── measure.mjs                   # 느린 spec · 재시도율 · workers 비교
│   ├── shard.mjs                     # 시간 균형 분할 · merge-reports 래퍼
│   ├── lock.mjs                      # heavy 1 배타 · light N 공유
│   └── util/{git,hash,exec,playwright-list}.mjs
├── skills/
│   ├── init/SKILL.md
│   ├── select/SKILL.md
│   ├── gate/SKILL.md
│   ├── measure/SKILL.md
│   └── shadow/SKILL.md
├── agents/e2e-impact-analyst.md
├── references/impact-analyst.md      # 에이전트 본문과 같은 점검 목록(Codex 가 읽는다)
├── hooks/hooks.json · hooks/doctrine.md
├── .agents/plugins/marketplace.json  # Codex 마켓(local source ./plugins/e2e-rail)
├── plugins/e2e-rail/                 # Codex 패키지 — skills/·hooks/·references/ 는 sync-codex 가 복사
│   └── .codex-plugin/plugin.json
├── scripts/sync-codex.mjs            # 루트 skills/hooks/references → plugins/e2e-rail/ 복사(멱등)
├── templates/
│   ├── e2e-rail.config.mjs
│   └── ci/{github-actions-shard.yml, codebuild-batch.yml, buildspec-snippet.yml}
├── test/                             # node:test · 의존성 0
│   ├── fixtures/sample-app/          # 소형 react-router 앱 + spec 4개 + support 1개
│   ├── fixtures/stub-playwright/     # PATH 에 끼우는 가짜 playwright(--list · test 흉내)
│   └── *.test.mjs
├── docs/superpowers/{specs,plans}/
├── .github/workflows/ci.yml          # node:test + 실 Playwright 계약 테스트 1개
├── README.md · README.ko.md · CHANGELOG.md · LICENSE(MIT)
```

## 3. 설정 파일 `e2e-rail.config.mjs`

레포 루트에 둔다. 모노레포는 `apps[]` 가 여러 개다.

```js
export default {
  apps: [
    {
      name: 'bfm',
      root: 'apps/bfm',                       // playwright config · spec · src 의 기준 디렉터리
      playwrightConfig: 'playwright.config.ts',
      specDir: 'e2e',
      supportDirs: ['e2e/support'],           // spec 이 import 하는 헬퍼(여기 변경은 tier.full)
      srcDir: 'src',
      tsconfig: 'tsconfig.json',              // paths 별칭(@/*) 해석용
      adapter: {
        name: 'react-router-lazy',
        routeFiles: ['src/features/*/routes.tsx', 'src/routes/router.tsx'],
        basePath: '/app',                     // 라우트 path 앞에 붙는 셸 접두
      },
      apiPrefix: '/api',
      alwaysRun: ['shell-smoke'],             // slug(확장자 제외). 어떤 선택에도 포함
      tiers: {
        full: [                               // 닿으면 이 앱 전수
          'src/main.tsx', 'src/routes/**', 'src/lib/auth/**', 'src/lib/api/**',
          'src/components/layout/**', 'src/stores/**', 'src/styles/**',
          'e2e/support/**', 'playwright.config.ts', 'vite.config.ts', 'index.html', 'package.json',
        ],
        ignore: ['**/*.md', 'docs/**', '**/*.test.ts', '**/*.test.tsx'],
      },
      run: {
        port: 5203,
        preview: { build: 'pnpm -F bfm build', dist: 'dist' },
        workers: { local: 5, ci: 1 },         // 측정값. measure 가 제안하고 사람이 쓴다
      },
    },
  ],
  shared: ['packages/**', 'pnpm-lock.yaml', 'biome.json', 'tsconfig*.json'],   // 닿으면 전 앱 전수
  ignore: ['**/*.md', 'docs/**', '.claude/**'],                                // 전역 무시
  shadow: { promoteAfter: 3 },                 // 연속 N 회 «실패 ⊂ 선택» 이면 승격
  ledger: { dir: '.e2e-rail' },                // gitignore 대상
};
```

검증 규칙: `apps[].root` 에 `playwrightConfig` 가 실재해야 한다 · `adapter.name` 은 레지스트리에 있어야 한다 · `tiers.full` 과 `ignore` 는 glob 문자열 배열 · 모르는 키는 경고(차단 아님).

## 4. spec 인덱스 (`e2e-rail map`)

spec 파일마다 다음을 뽑아 `.e2e-rail/map.json` 에 캐시한다(키 = spec·support 파일 내용 해시 + playwright config 해시).

| 항목 | 추출 방법 | 비고 |
| --- | --- | --- |
| `tests[]` | `playwright test --list --reporter=json` 1회 | 프로젝트(chromium · mobile-chrome)별 정본. `testMatch` 를 직접 흉내 내지 않는다 |
| `routes[]` | TypeScript AST 로 `goto(<expr>)` 수집 → 식별자 해석 | 아래 «해석 규칙» |
| `apis[]` | `route(<literal>)` 또는 `route(<template>)` 의 글롭 | spec 본문 + **import 한 support 모듈 전체**의 `route(` 를 합집합(헬퍼 함수 호출을 실행 없이 특정할 수 없어 과대 근사) |
| `imports[]` | `@/…` 또는 상대 경로로 `src` 를 import 한 파일 | 그 파일 변경은 직접 선택 |
| `supports[]` | `./support/*` import | support 변경은 tier.full 이지만 `map --explain` 에 표시 |
| `unmapped` | `routes[]` 가 비면 true | 앱 소스가 하나라도 바뀌면 항상 선택 |

**`goto` 식별자 해석 규칙** (실측: 145 spec 중 10개는 리터럴 `goto` 가 없고 `goto(PAGE)` 같은 상수를 쓴다 · 19개는 템플릿 리터럴)
1. 문자열 리터럴 → 그대로. 쿼리스트링·해시 제거.
2. 식별자 → 같은 파일의 `const X = '<literal>'` · `const X = { a: '<literal>' }` 의 속성 접근 → 리터럴.
3. import 한 식별자 → 그 모듈(e2e 트리 안)의 export 를 같은 규칙으로 1단계 더 해석. 그 이상은 추적하지 않는다.
4. 템플릿 리터럴 → 치환 전부가 1~3 으로 풀리면 합성. 아니면 **앞쪽 리터럴 접두 + `*`**(`/app/orders/${id}` → `/app/orders/*`).
5. 그래도 못 풀면 그 `goto` 는 버리고, 결과적으로 `routes[]` 가 비면 `unmapped`.

라우트 정규화: `basePath` 를 떼고(`/app/orders/history` → `orders/history`), 파라미터 세그먼트는 `*` 로. 매칭은 **라우터 path 패턴 ↔ spec 라우트** 를 세그먼트 단위로 비교한다(`orders/:id` 는 `orders/*` 와 `orders/123` 에 모두 매치).

`map --check` 는 `unmapped` spec 목록과 그 비율을 출력한다. 팀은 그 spec 에 리터럴 상수를 넣어 비율을 줄인다. 이 수치는 선택기의 «좁힐 수 있는 상한» 이다.

## 5. 소스 그래프 (`graph.mjs`) 와 어댑터

**어댑터 인터페이스**
```ts
interface Adapter {
  name: string;
  /** 라우트 패턴 → 진입 파일(절대 경로). 못 읽는 routeFile 이 있으면 unresolved 에 적는다 */
  routeEntries(app: AppConfig): Promise<{ entries: Array<{ route: string; file: string }>; unresolved: string[] }>;
}
```
- `react-router-lazy`: `routeFiles` 글롭의 각 파일을 TS AST 로 읽어 `{ path: '<literal>', lazy: … import('<module>') }` 쌍을 뽑는다. 중첩 `children` 은 부모 path 를 접두로 합성. `path` 가 리터럴이 아니거나 `import()` 가 리터럴이 아니면 `unresolved`.
- `manual`: 설정 `adapter.map: { '<route>': ['src/…'] }` 를 그대로 반환. 어댑터가 없는 프레임워크의 폴백.
- v1.1 후보: `next-app-router`(파일 시스템 라우팅이라 `app/**/page.tsx` 경로에서 바로 유도).

**역방향 import 그래프**
- `ts.createProgram({ rootNames: <srcDir 전체>, options: tsconfig })` 로 각 파일의 resolved imports 를 얻어 역방향 간선을 만든다. `paths` 별칭·`index` 해석은 TS 에 맡긴다.
- 캐시 `.e2e-rail/graph.json`, 키 = `src` 파일 목록 + mtime 해시. 캐시 미스면 재빌드(실측 목표: 145 spec 규모의 앱에서 5초 이내 · 계획서에서 측정).
- 질의: `affectedEntries(changedFiles) → { entries: Set<file>, unresolved: string[], mainOnly: string[] }`. 변경 파일에서 역방향 BFS 로 올라가며 어댑터의 진입 파일에 닿으면 수집. **어떤 진입 파일에도 닿지 않고 `main` 에도 닿지 않는 파일**(죽은 코드 또는 그래프 밖)은 `unresolved`, **진입 파일 없이 `main` 에만 닿는 파일**(라우트 밖 전역 결합: 스토어·셸·전역 스타일)은 `mainOnly` 에 넣는다. 둘 중 하나라도 있으면 그 앱은 전수(이유 `graph-unresolved:<file>` · `graph-main-only:<file>`). «닿는 라우트가 0» 을 «돌릴 spec 이 0» 으로 읽는 것이 선택기가 좁혀서 틀리는 유일한 길이라 이렇게 막는다.

**API 축**: 변경 파일 중 `services/**` 또는 `src/lib/api/**` 이면 그 파일 안의 `'/api/…'` 리터럴(`GET('/api/…')` 등)을 뽑아 spec 의 `apis[]` 글롭과 매치한다. 리터럴이 하나도 없으면 그래프 축으로만 간다(소비 페이지 → 라우트 → spec). 둘은 합집합이다.

## 6. 선택 규칙 (`e2e-rail select`)

입력: `--base <ref>`(필수 아님) · `--head <ref|HEAD>` · `--include-uncommitted`(로컬 기본 on · `CI=true` 면 기본 off). base 가 없거나 diff 가 실패하면 **전수**(«모른다» 는 «변경 없음» 이 아니다).

파일 분류는 위에서 아래로 처음 맞는 행을 따른다.

| 순서 | 조건 | 결과 |
| --- | --- | --- |
| 1 | 전역 `ignore` 또는 앱 `tiers.ignore` 매치 | 무시 |
| 2 | `shared` 매치 | **전 앱 전수**(이유 `shared`) |
| 3 | 어느 앱 `root` 에도 속하지 않음 | **전 앱 전수**(이유 `unknown-root`) |
| 4 | 앱 `tiers.full` 매치 | **그 앱 전수**(이유 `tier-full:<glob>`) |
| 5 | `specDir` 의 spec 파일 | 그 spec(이유 `spec-self`) |
| 6 | `supportDirs` 파일 | 그 앱 전수(기본 tier.full 에 들어 있다. 사용자가 뺐으면 그 support 를 import 하는 spec 만) |
| 7 | `srcDir` 파일 | §5 그래프·API 축 → 라우트·API 매치 spec + `imports[]` 로 직접 import 하는 spec. `unresolved` 가 생기면 그 앱 전수(이유 `graph-unresolved:<file>`) |
| 8 | 그 외 앱 파일(설정·자산) | 그 앱 전수(이유 `app-other`) |

후처리: 앱 소스 변경이 1건 이상이면 `unmapped` spec 과 `alwaysRun` 을 더한다. 전수로 판정된 앱은 spec 목록 대신 `mode: 'full'` 이다.

출력
- `.e2e-rail/selection.json`
  ```json
  { "id": "sel-20261007-153012-ab12", "base": "c471e636", "head": "HEAD", "includeUncommitted": true,
    "fingerprint": { … §7 … },
    "apps": { "bfm": { "mode": "partial", "specs": [ { "file": "e2e/order-delivery.spec.ts",
        "projects": ["chromium", "mobile-chrome"], "reasons": ["route:orders ← src/features/orm/order/OrderDeliveryPage.tsx"] } ],
        "added": [], "removed": [], "unmappedIncluded": 10, "changedFiles": 3 } } }
  ```
- 앱마다 `.e2e-rail/test-list.<app>.txt` — 한 줄에 `[<project>] › <specDir>/<file>` (Playwright `--test-list` 형식). 전수면 파일을 쓰지 않고 `mode: full`.
- 종료 코드: 0 = partial · 10 = full(스크립트가 분기하기 쉽게) · 1 = 오류.

**에이전트 보정**: `select --add <spec> --reason "<문장>"` 은 허용(기록). `select --remove <spec> --reason` 은 허용하되 `removed[]` 에 남고 섀도 대조에서 «삭제한 spec 이 전수에서 실패» 하면 별도 카운트한다. 삭제는 승격 상태(§8)에서만 허용한다.

## 7. 지문과 원장

**지문(fingerprint)** — 무엇을 검증했는지의 정체성.
```json
{ "head": "<git rev-parse HEAD>",
  "diff": "<sha256(git diff HEAD --binary)>",
  "untracked": "<sha256(ls-files --others --exclude-standard 의 경로+내용)>",
  "config": "<sha256(playwright config + e2e-rail config)>",
  "playwright": "1.61.0",
  "dist": "<sha256(dist 파일 경로+크기+내용) | null(dev 모드)>" }
```
`fingerprint.id = sha256(위 6개 직렬화)` · `fingerprint.codeId = sha256(head + diff + untracked)`. `id` 는 «이 실행이 검증한 것» 의 정체성이고, `codeId` 는 «코드만의» 정체성이다. 섀도 짝짓기(§8)는 `codeId` 로 한다. 선택은 빌드 전에 계산되므로 `dist` 가 다르기 때문이다. `dist` 는 preview 모드에서만 채우고, **`dist` 가 `src` 보다 오래됐으면 run 이 거부하거나(`--no-build`) 빌드부터 한다**(기본). «preview 실행은 빌드 산출물이 현재 코드와 일치하는지 확인해야 한다» 는 요구를 이 필드가 담당한다.

**원장** `.e2e-rail/ledger.jsonl` — 실행 1회 = 1줄, append-only, gitignore.
```json
{ "id": "run-20261007-153500-9f3e", "ts": "2026-10-07T15:35:00+09:00", "app": "bfm",
  "kind": "full | selected | rerun | shard", "mode": "dev | preview",
  "fingerprint": { "id": "…", "head": "…", "diff": "…", "untracked": "…", "config": "…", "playwright": "…", "dist": "…" },
  "selectionId": "sel-…|null", "shard": { "index": 2, "count": 4 } | null,
  "workers": 5, "command": "playwright test --test-list … --reporter=json,list",
  "lock": { "class": "heavy", "waitMs": 0, "loadAtStart": 3.1 },
  "rc": 0, "durationMs": 663000,
  "specs": [ { "file": "e2e/order-cart.spec.ts", "project": "chromium", "status": "passed", "durationMs": 8300, "retries": 0 } ],
  "failures": [ { "file": "…", "title": "…", "project": "…", "error": "<첫 줄>" } ],
  "flaky": [ … retries>0 이고 최종 passed … ] }
```
spec 별 결과는 Playwright JSON 리포터(`PLAYWRIGHT_JSON_OUTPUT_NAME`)를 파싱한다. 표준 출력엔 `list` 리포터를 유지한다.

**`kind` 의 의미는 스크립트가 강제한다.**
- `rerun`(`--last-failed`)은 진단용이다. `verify --require full` 을 절대 만족시키지 않는다.
- `shard` 는 같은 `fingerprint.id` 에서 `count` 개가 모두 rc 0 일 때만 `verify` 가 `full` 로 친다.
- `selected` 는 섀도 상태(§8)에서는 «가벼운 검증» 으로만 보고된다.

## 8. `verify` 와 섀도 모드

**`e2e-rail verify [--app] [--require full|selected] [--max-age <분>]`**
현재 지문을 계산하고 원장에서 같은 `fingerprint.id` 의 최신 실행을 찾는다.
- 있음 → `verified: full@run-… (12분 전)` + 종료 0.
- 지문 다름 → 어느 필드가 다른지(`diff` · `untracked` · `dist` …) 와 마지막 검증 head 를 출력, 종료 20. 에이전트는 이걸 근거로 `select --base <마지막 검증 head>` 로 좁힌다.
- `--require full` 인데 `selected`/`rerun` 만 있음 → 종료 21.
이 명령이 «아까 통과했다» 를 근거로 낡은 결과를 쓰는 일을 막는 장치다. 스킬 `gate` 는 보고 전에 반드시 호출한다.

**섀도 모드** — 선택기를 믿기 전까지 전수와 나란히 돈다.
- 상태 `.e2e-rail/state.json` `{ "trust": "shadow" | "selected", "streak": 2, "window": [ … ] }`. `init` 은 `shadow` 로 시작.
- `shadow record --run <run-id>`: `kind: full` 실행 1건과 **같은 `codeId`** 의 selection(`.e2e-rail/selections/<id>.json` 에 보관)을 짝지어 `failures ⊂ selection.specs` 인지 판정. selection 이 `mode: full` 이면 증명하는 것이 없으므로 `trivial: true` 로 기록만 하고 streak 를 움직이지 않는다. `{ fp, hit: true|false, missed: [ … ], removedMissed: [ … ] }` 를 `.e2e-rail/shadow.jsonl` 에 남기고 streak 갱신. missed 가 있으면 streak 0 으로.
- `shadow status`: streak · promoteAfter · 최근 miss 목록. streak ≥ promoteAfter 면 «승격 가능» 을 출력하고 `shadow promote` 로 사람이 승격한다(자동 승격 없음). `shadow demote` 로 되돌린다.
- `run --selection` 은 `trust: shadow` 에서도 돌 수 있지만 원장에 `shadowed: true` 가 붙고, `gate` 스킬의 보고 형식이 «선택 실행(섀도 · 전수 대체 아님)» 으로 고정된다.

섀도 비용은 0 이다. 전수는 어차피 돌고, 선택은 계산만 한다.

## 9. `run` · 락 · 워커 · 분산

**`e2e-rail run --app <app> (--full | --selection [<selection.json>] | --test-list <file> | --last-failed) [--mode dev|preview] [--workers N] [--project <name>] [--shard i/n] [--reporter blob] [--no-lock] [--no-build]`**
1. 지문 계산(preview 면 dist 검사 → 필요 시 `run.preview.build` 실행 → dist 해시).
2. 락 획득(`--full`·`--shard` = heavy · 그 외 = light. `--workers` 없는 실행은 heavy 로 분류).
3. `playwright test` 를 `spawn` 으로 실행. 인자는 Playwright 에 그대로 전달하고 `--reporter=list,json` 을 덧붙인다. 환경 `CI`·`E2E_PREVIEW` 는 레포 설정을 존중한다(플러그인이 덮어쓰지 않고 `run.env` 로 사용자가 지정).
4. JSON 결과 파싱 → 원장 1줄. rc 는 그대로 반환.

**락(`lock.mjs`)** — `gate-lock.sh` 의 규칙을 node 로 옮긴다.
- heavy 1 배타: 잡는 순간 새 light 진입을 막고, 돌던 light 가 끝나길 기다린 뒤 혼자 돈다.
- light N 공유(기본 2). heavy 가 있으면 대기.
- 락 디렉터리 `os.tmpdir()/e2e-rail-lock/<repo-hash>/`. 보유 pid 가 죽은 고아 락만 `lock reap` 이 지운다.
- 요청·획득·해제 시각 · 대기 초 · 획득 시 1분 부하를 원장 `lock` 필드에 남긴다.

**워커** — 플러그인은 값을 정하지 않는다. `measure workers 1,2,4 --app bfm --test-list <file>` 이 같은 목록을 순서대로 돌리고 벽시계 · 실패 · 재시도 · 부하를 표로 낸다. 사람이 `run.workers` 에 쓴다. 근거: 같은 머신에서 워커 5→8 이 실효 병렬도를 떨어뜨리고 타임아웃 10건을 낸 실측이 있다. 값은 레포마다 다르다.

**분산(`shard.mjs`)**
- `shard plan --app bfm --count N [--from-run <run-id>]`: 원장의 최근 `full` 실행에서 spec 별 시간을 읽어 **그리디 균형 분할**(가장 긴 것부터 가장 가벼운 샤드에). 시간이 없는 spec 은 중앙값으로 가정. 출력 `.e2e-rail/shards/<app>/<i>.txt`(test-list 형식) + `manifest.json`(예상 시간).
- 각 CI 잡: `e2e-rail run --app bfm --test-list .e2e-rail/shards/bfm/<i>.txt --shard i/N --reporter blob`. 원장 `kind: shard`.
- `shard merge --dir <blob 모음>`: `playwright merge-reports` 를 호출해 HTML 을 만들고, 원장에서 같은 지문의 샤드 N 개가 모두 rc 0 이면 `verify` 가 `full` 로 인정한다.
- 템플릿 2종: GitHub Actions `matrix`(`templates/ci/github-actions-shard.yml`) · CodeBuild batch build-graph(`templates/ci/codebuild-batch.yml`). CI 인프라가 없는 레포는 `shard plan` 까지만 쓰고 한 머신에서 순서대로 돌려도 된다(그래도 원장은 합쳐진다).

**CI 에서 `--base` 의 출처**: `run` 이 성공한 `full` 의 head 를 `.e2e-rail/last-green.<app>` 에 남긴다. CI 는 이 파일을 캐시·아티팩트로 보존해 다음 빌드에 `select --base $(cat …)` 로 쓴다. shallow clone 이면 `git fetch --depth` 를 늘리거나 전수로 떨어진다(스크립트가 `base` 를 못 찾으면 전수). CI 좁히기는 **승격(§8) 이후**에만 켠다.

## 10. 스킬 · 에이전트 · 훅

| 스킬 | 언제 | 무엇을 |
| --- | --- | --- |
| `e2e-rail:init` | 레포에 처음 | devDependency 설치 확인 → `init` 실행(설정 파일 생성 · playwright config 탐지 · `.gitignore` 에 `.e2e-rail/` · `package.json` 에 `e2e:select/run/verify` 스크립트 제안) → `map --check` 로 unmapped 비율 보고 |
| `e2e-rail:select` | 변경 후 돌릴 범위를 정할 때 | `select` 실행 → 결과와 함께 **선택 블록** 작성(아래 형식). 추가는 `--add --reason`, 삭제는 승격 상태에서만 |
| `e2e-rail:gate` | 돌리고 보고할 때 | `run` → `verify` → 보고 형식 고정. `rerun` 을 전수로 보고 금지 · 섀도면 «전수 대체 아님» 명시 · 실패는 원장 run-id 와 함께 |
| `e2e-rail:measure` | 느리다고 느낄 때 | ① spec 별 시간·재시도 상위 ② 페이지 진입·응답 대기·반복 준비 중 어디가 느린지 분리(trace 권고) ③ `measure workers` ④ 그래도 길면 `shard plan` |
| `e2e-rail:shadow` | 라운드 마감 | `shadow record` → `status` → 승격 가능하면 사람에게 제안(자동 승격 없음) |

**선택 블록 형식**(스킬 `select` 의 출력 · 보고서에 그대로 붙인다)
```
변경: 주문배송조회 검색 조건(src/features/orm/order/components/OrderDeliverySearchFilter.tsx 외 2)
선택: order-delivery · order-detail (근거: route orders ← OrderDeliveryPage · api **/api/M3/orm/odr/** ← services/order.ts)
추가: 없음 / 삭제: 없음
모바일: order-delivery 는 mobile-chrome 포함(playwright --list 기준)
unmapped 포함: 10 (map --check)
최종 전수: 합본 단계 예정 · 현재 trust=shadow
```

**에이전트 `e2e-impact-analyst`**(READ-ONLY · Read/Grep/Glob/Bash): 변경 diff 와 `selection.json` 을 받아 «스크립트가 놓쳤을 가능성» 만 찾는다. 모달 오프너 · 딥링크 · 런타임 문자열 라우트 · `import.meta.glob` 같은 정적 그래프 밖 결합을 점검하고 `--add` 후보와 사유를 돌려준다. 삭제 제안은 하지 않는다.

**런타임 분기**: 스킬 `select` 의 «놓친 결합 점검» 단계만 갈린다. Claude 는 `e2e-impact-analyst` 에이전트에 위임하고, Codex 는 `references/impact-analyst.md`(같은 점검 목록)를 읽어 스킬 안에서 수행한다. 그 외 스킬 본문은 동일하며 `pnpm exec e2e-rail …` 만 호출한다.

**훅**: `SessionStart` 1개가 `hooks/doctrine.md`(10줄 이내)를 주입한다. Claude 는 `hooks/hooks.json`(`cat "${CLAUDE_PLUGIN_ROOT}/hooks/doctrine.md"`), Codex 는 `plugins/e2e-rail/hooks/hooks.json` 으로 같은 파일을 읽는다(Codex 는 설치 후 `/hooks` 에서 사람이 한 번 신뢰해야 한다). 내용: «보고 전 `verify` · `rerun` ≠ 전수 · 선택 블록 없이 선택 실행 보고 금지 · 섀도 상태 명시». PreToolUse 가드는 v1 에 넣지 않는다(직접 `playwright test` 실행을 막으면 디버깅을 방해한다. 대신 `verify` 가 원장에 없는 실행을 «미검증» 으로 취급하는 것으로 충분하다).

## 11. 테스트 전략 (플러그인 자신)

- 러너 `node:test`. 의존성 0 유지.
- `test/fixtures/sample-app`: 소형 react-router 앱(`routes.tsx` 2개 · 페이지 4 · 공용 컴포넌트 1 · service 1) + spec 4개(리터럴 goto · 상수 goto · 템플릿 goto · unmapped 1) + support 1개(route 글롭 보유). 이 픽스처로 `map` · `graph` · `select` 의 모든 규칙 행(§6 표 1~8)을 단위 테스트한다.
- `test/fixtures/stub-playwright`: PATH 에 끼우는 가짜 `playwright` 가 `--list --reporter=json` 과 `test --reporter=json` 의 산출물을 흉내 낸다. `run` · `ledger` · `verify` · `shadow` · `shard` 를 브라우저 없이 검증한다.
- 계약 테스트 1개(GitHub Actions 에서만): 실제 `@playwright/test` 를 설치해 픽스처 spec 2개를 `run --full` 로 돌리고 원장 1줄과 `verify` 종료 0 을 확인한다. `--test-list` 형식 · JSON 리포터 스키마가 Playwright 버전에 따라 바뀌는 것을 여기서 잡는다.
- 지문 테스트: 미커밋 변경 · untracked 추가 · dist 갱신 각각이 `fingerprint.id` 를 바꾸는지.
- 락 테스트: heavy 가 light 진입을 막고, 고아 락만 reap 되는지(자식 프로세스 2개로).

## 12. 첫 도입 레포(bfm-fo-front) 적용 절차

1. `pnpm add -D github:sh5623/e2e-rail#v0.1.0` → `/e2e-rail:init` → `map --check`(unmapped 10/145 예상).
2. 기존 `.claude/rounds/*-final-gate.sh` 의 `07-e2e` 단계를 `e2e-rail run --app bfm --full --mode preview` 로 바꾸고 `shadow record` 를 덧붙인다. `gate-lock.sh` 는 `e2e-rail lock` 으로 대체 가능하나 v1 기간엔 병존(락 디렉터리가 달라 서로 모른다 → 같은 라운드에서 둘을 섞지 않는다).
3. 라운드 3회 섀도 → `shadow status` → 승격.
4. 승격 후 동작 변경 트랙의 «자기 E2E 스펙 파일 실행» 을 `select` + `run --selection` 으로 바꾼다. AGENT-BRIEF 의 가벼운 검증 조항에 포인터 1줄.
5. CI 좁히기는 인프라(아티팩트 보존) 준비 뒤 별도 결정.

## 13. 알려진 한계와 v2 후보

- 정적 그래프는 **문자열 라우트 점프**(`navigate('/x')`)와 런타임 등록을 못 본다. 완화: `tiers.full` 에 셸·라우터를 넣고, 에이전트가 오프너 결합을 점검하며, 섀도가 누락을 센다.
- `apis[]` 는 support 모듈 단위 합집합이라 과대 근사다. 좁히려면 `map --explain <spec>` 으로 보고 support 를 쪼갠다.
- unmapped spec 은 소스 변경마다 돈다. 비율이 선택 효율의 상한이다.
- v2: V8 커버리지 기반 «파일→spec» 을 전수 때 수집해 그래프 결과와 대조(정확도 검증층) · `next-app-router` 어댑터 · PreToolUse 가드 · 원장 원격 저장(S3) · tester-army/e2e 류 여정 테스트를 `alwaysRun` 에 얹는 가이드.
