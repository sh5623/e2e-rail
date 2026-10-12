# 자동 운영 인계 보고서 검토 — 채택·변경·보류 판정

작성일: 2026-10-12 KST · 검토 대상: `2026-10-12-agentic-autopilot-handoff.md` · 대조 기준: v0.2.3 `63c2bfe`(= 원격 = 설치본)
검토 방법: 소스 직접 대조(`src/config.mjs`·`fingerprint.mjs`·`shadow.mjs`·`commands/{select,run}.mjs`·`skills/*`), 단위 테스트 재실행, BFM 개인 설치 실태 확인, 두 런타임 공식 문서 조사(훅 지원표).

## 0. 결론 한 줄

보고서의 문제 인식은 전부 맞다. 다만 **§4 실행기 결정은 이미 실태가 내려져 있고**(Claude 는 플러그인 번들 CLI 로 운영 중), **§5 의 «두 런타임 동등 자동화» 는 Codex 훅 신뢰 모델 때문에 성립하지 않는다**. 1차 범위는 아래 5건으로 줄이고, 나머지는 보류한다.

## 1. 실측으로 확인한 사실 (보고서에 없거나 다른 것)

| # | 사실 | 근거 |
| --- | --- | --- |
| F1 | 단위 테스트 307/307 통과 (2026-10-12 재실행) | `npm test` rc 0 |
| F2 | **Claude 쪽은 이미 플러그인 번들 CLI 다.** BFM 은 `package.json` 에 e2e-rail 없음 · 플러그인 캐시 `~/.claude/plugins/cache/guardrail/e2e-rail/0.2.3/bin/e2e-rail.mjs` 가 PATH · config·`.e2e-rail/` 은 레포 루트에 두고 `.git/info/exclude` 로 숨김 | `installed_plugins.json` · BFM `.git/info/exclude` · 메모리 `e2e-rail-personal-only` |
| F3 | 스킬·doctrine 은 전부 `pnpm exec e2e-rail` 로 고정 → **실태와 불일치**(사용자가 매번 `e2e-rail.mjs` 로 바꿔 읽는다) | `skills/*/SKILL.md` |
| F4 | 외부 상태 경로는 **미지원**: config 는 `cwd/e2e-rail.config.mjs` 고정, `ledger.dir` 은 config root 상대 | `src/config.mjs` `loadConfig`·`ledgerDir` |
| F5 | Codex 패키지 `plugins/e2e-rail/` 에 CLI 없음(skills·references·hooks 만) · **사용자 Codex 에 e2e-rail 미설치**(`~/.codex/config.toml` 에 항목 없음) | `scripts/sync-codex.mjs` · config.toml |
| F6 | 자동 재선택은 `--add` 만 이월하고 «검토 완료» 지문은 없음 → 보고서 §2·§6 지적 확인 | `src/commands/run.mjs` `reselect` |
| F7 | 섀도 상태는 앱 공통 `state.json` 1개 · 전수 통과 = hit | `src/shadow.mjs` |
| F8 | 설계 원본(§10)은 PreToolUse 가드를 v1 에서 **의도적으로 제외**(디버깅 방해) | `2026-10-07-e2e-rail-design.md` §10 |
| F9 | BFM 섀도 운영 7회(170~176) 중 드릴(§6) 0회 — 승격 전 1회 필요 | 메모리 `e2e-rail-bfm-adoption-plan` |

## 2. 런타임 훅 지원표 (보고서 §5 의 빈 표 — 2026-10-12 공식 문서 기준)

| 항목 | Claude Code | Codex |
| --- | --- | --- |
| 세션 시작 주입 | `SessionStart`(matcher `startup/resume/clear/compact`) · `additionalContext` | `SessionStart`(`source` 동일) |
| 파일 편집 관찰 | `PostToolUse` matcher `Edit\|Write`(Bash 편집은 `FileChanged`+`watchPaths`) | `PostToolUse` matcher `apply_patch`(경로 필드 미확인) |
| 턴 종료 검사·차단 | **`Stop`** — `decision:"block"`+`reason` 또는 exit 2 · `stop_hook_active` 재귀 가드 · 연속 8회 캡 | `Stop` — block 가능 · `reason` 이 **새 사용자 프롬프트**로 들어감 · 캡 미확인 |
| 셸 가로채기 | `PreToolUse` matcher `Bash` · `allow/deny/ask` · `if:` 로 명령 패턴 좁힘 | `PreToolUse` `Bash` · `allow/deny` 만(`ask` 없음) |
| 압축 생존 | `PreCompact`→`PostCompact`→`SessionStart compact` 재주입 | 동일 구조 |
| **플러그인 훅 활성화** | 설치 = 즉시 발화(폴더 trust 전제) · `hooks/` 변경은 `/reload-plugins` | 🔴 **사용자가 `/hooks` 에서 해시 단위로 trust 하기 전까지 조용히 스킵** · 정의 바뀌면 재신뢰 · 훅 포함 플러그인은 공개 디렉터리 등록 불가 · CLI 지원 미확인 |
| env | `CLAUDE_PLUGIN_ROOT`(버전마다 바뀜) · `CLAUDE_PLUGIN_DATA`(영속) · `CLAUDE_PROJECT_DIR` | `PLUGIN_ROOT`/`PLUGIN_DATA` + 호환용 `CLAUDE_PLUGIN_*` |

출처: https://code.claude.com/docs/en/hooks · https://code.claude.com/docs/en/plugins/components · https://learn.chatgpt.com/docs/hooks · https://developers.openai.com/plugins/build/plugins

**판정:** 코드로 강제할 수 있는 층(Stop 차단·편집 관찰)은 **Claude Code 에서만** 설계한다. Codex 는 스킬 본문 + CLI 원장(원장 밖 실행 = 미검증)에 의존하고, 그 사실을 문서에 «모델 준수 의존» 으로 명시한다. 보고서 §11 «훅 미신뢰·지원 이벤트 없음 → 미검증 상태 명확화» 가 Codex 의 기본 경로다.

## 3. 항목별 판정

### 채택 (1차 범위)

| # | 항목 | 변경점 | 근거 |
| --- | --- | --- | --- |
| A1 | **shadow §6 드릴 격리·복구 재작성** (보고서 §9) | 브랜치 전환 대신 `git worktree add <scratch> HEAD` + 미커밋 변경은 `git diff` 스냅샷을 scratch 에 적용 · scratch 에 config 복사(→ `ledger.dir` 이 scratch 상대라 원장 자동 분리) · 종료 시 `git worktree remove --force` · 미러 `pnpm sync:codex` | 보고서 지적은 git 의미상 맞다(미커밋 편집은 `switch` 를 따라간다). **보고서가 덜 짚은 위험 2개 추가**: 드릴의 `select` 가 실제 `selection.json` 을 덮어쓴다 · 드릴의 `run --full` 실패가 실제 원장에 남아 다음 `verify` 가 failure/insufficient 를 낸다(last-green 은 실패 run 이라 안전) |
| A2 | **실행기 탐지 + 개인 모드 상태 경로** (보고서 §4) | 스킬·doctrine 의 `pnpm exec e2e-rail` 을 «프로젝트 bin → 플러그인 bin(`${CLAUDE_PLUGIN_ROOT}/bin/e2e-rail.mjs`)» 탐지로 · `E2E_RAIL_HOME`(기본 `~/.e2e-rail/<repo-id>/`) 에서 config·ledger 를 읽는 옵션 · init 에 `--personal`(package.json·lock·.gitignore 무변경 · `.git/info/exclude` 안내) · devDep 설치는 «팀·CI 옵션» 으로 강등 | F2·F3·F4. 결정은 이미 실태로 내려졌다 — 권고대로 개인 = 플러그인 번들, 팀·CI = 프로젝트 고정. 주의: fingerprint 가 ledger 를 untracked 에서 빼는 `ledgerRel` 로직은 레포 밖 경로면 자연히 비게 되므로 단순해진다 · 워크트리마다 다른 `<repo-id>` 가 필요(보고서 «레포·워크트리 섞이면 안 된다» 수용: `git rev-parse --show-toplevel` 해시) |
| A3 | **`status` 명령 1개** (보고서 §6 «준비 상태·유효한 검증 결과» 의 최소형) | JSON: 준비(config·실행기 버전·Playwright 버전·map 신선도) · 현재 `codeId` · 이 code 에 유효한 verify(mode 별) · 현재 selection 이 이 code 용인지 · 검토 기록 유효 여부 · trust/streak · 락 상태 | 훅·통합 스킬·사람이 같은 판정을 읽는다. 상태 머신 7단계 전체는 보류하고 이 출력으로 대신한다 |
| A4 | **검토 기록 필드 + 무효화** (보고서 §6) | `select --review-done --reason "<근거>"` → `selection.json` 에 `review:{codeId, listSha, checklist:'impact-analyst@<hash>', ts}` · `run.mjs reselect` 가 codeId 바뀌면 `review` 를 **버린다**(`--add` 는 계속 이월) · `status` 와 gate 스킬이 «검토 없음/구버전» 을 보고 | F6. 보고서 «기록 유효 ≠ 추론 옳음» 수용: 누락 탐지는 계속 섀도가 센다 |
| A5 | **Claude Stop 훅 + 통합 진입 스킬** (보고서 §5·§6) | `Stop` 훅: `status --json` 만 읽어 «소스 변경 있음 ∧ 이 code 에 유효한 verify 없음 ∧ `stop_hook_active` 아님» 일 때만 block + reason(«e2e-rail: 변경 N파일 · 미검증 · `e2e-rail:autopilot` 진행») · 실행은 훅이 아니라 에이전트가 CLI 로 · 스킬 `autopilot` 은 기존 select→gate→(shadow) 를 내부 절차로 호출 · 문서·설명 요청은 `status` 가 «변경 없음» 이라 통과 | §2 지원표. 설계 §10 의 PreToolUse 제외는 유지(F8) — 직접 `playwright test` 는 `PostToolUse Bash` 관찰로 «원장 밖 = 미검증» 안내만. 8회 캡과 `stop_hook_active` 로 재귀 차단. **훅은 `CLAUDE_PLUGIN_ROOT` 버전별 경로이므로 상태는 `CLAUDE_PLUGIN_DATA`/`E2E_RAIL_HOME` 에** |

### 변경해서 채택

| # | 보고서 원안 | 변경 |
| --- | --- | --- |
| B1 | 실행기 번들을 Claude·Codex 양쪽에 (§4) | **Claude 만**. Codex 는 미설치(F5)라 평가 자체가 불가 — Codex 번들(`sync-codex` 에 `bin/src/package.json` 추가)은 사용자가 Codex 에 설치하는 시점으로 미룬다 |
| B2 | 섀도 «전수 성공 = hit» 재정의 (§9) | 계산은 유지(이력 호환). `shadow status` 와 승격 제안 문구에 **«실패 포착 0회 · 드릴 0회»** 를 붙여 사람이 보게 한다. 앱별 state 분리는 BFM 에서 sfm 이 늘 trivial 이라 실익 0 → 보류 |
| B3 | 초기 설정 «묶어서 한 번 확인» (§3) | 승인 기억은 런타임 권한에 맡기고, e2e-rail 은 `init --personal` 이 **프로젝트 파일을 아예 안 건드리는** 것으로 질문 자체를 없앤다 |

### 보류 (2차 이후 · 측정 뒤)

- §7 관계 재사용 저장소(모달 오프너 등 구조화 근거) — 드릴·miss 가 실제로 나온 뒤 형태를 정한다.
- §8 미매핑 원인·반복 비용 진단, 실패 진단 한도·trace 묶음, 실행 순서 최적화 — `measure` 원장에 시간이 쌓인 뒤.
- §8 커버리지 기반 실행 소스 매핑 — 설계 §13 v2 그대로.
- §6 7단계 상태 머신 — `status` JSON 으로 충분한지 A5 실대화 평가 뒤 판단.

## 4. 구현 순서와 추정

| 순서 | 산출물 | 완료 조건 | 추정(실행자 기준) |
| --- | --- | --- | --- |
| 1 | A1 드릴 재작성(skills + 미러 + 미러 동일성 테스트) | 임시 레포에서 dirty 원본 보존·중단 복구 실측 · BFM 177 에서 드릴 1회 | 30분 + 드릴 실행 |
| 2 | A2 실행기 탐지·`E2E_RAIL_HOME`·`init --personal` | BFM 에서 `.git/info/exclude` 없이도 `git status` 0줄 · 기존 `.e2e-rail/` 원장 이전 절차 문서화 | 반나절 |
| 3 | A3 `status` + A4 검토 기록·무효화 | 단위 테스트(codeId 변경 → review 소멸 · `--add` 이월 유지) | 반나절 |
| 4 | A5 Stop 훅 + `autopilot` 스킬 + doctrine 갱신 | 보고서 §11 시나리오 중 «주문 검색 조건 수정」·「코드 설명」·「재개 중복 없음」·「세션 압축 뒤」 4건을 **프롬프트에 스킬명 없이** 실대화로 평가 · 평가 기록(런타임·모델·버전·개입 횟수) | 반나절 + 평가 |
| 5 | 버전·태그 | 새 명령·훅 = 동작 변경 → `0.3.0` · 원격 최신 태그 `v0.2.3` 확인 뒤 · `VERIFY_POLICY` 는 통과 의미가 안 바뀌므로 2 유지 | — |

커밋·태그·푸시·플러그인 업데이트는 그 세션의 사용자 지시를 따른다(보고서 §13 유지).

## 5. 구현자가 지킬 불변식 (보고서에서 그대로 가져옴)

- 좁히기는 추측으로 하지 않는다 · `--last-failed` 는 진단 · 섀도 기간 선택 실행은 전수를 대체하지 않는다 · 승격은 사람.
- 훅은 판정만, 실행은 CLI 원장을 거친다 · 원장 밖 실행은 미검증.
- 자동 기대값 완화·자동 skip 으로 초록을 만들지 않는다.
- 실패 단독 재실행 성공을 전체 성공으로 보고하지 않는다.

## 6. 구현 결과 (2026-10-12 · 워킹 트리 · 미커밋 · 버전 파일 0.3.0)

| 단계 | 산출물 | 검증 |
| --- | --- | --- |
| A1 드릴 격리 | shadow §6 을 `git worktree add --detach` + 패치 복사 + 전후 상태 해시 비교로 재작성 · README 영·한 · 미러 | 임시 레포 실측: 기존 절차는 고장이 원본에 남고 **사용자 미커밋 변경이 덮어써져 사라짐**(보고서보다 심각). 새 절차는 드릴 중·후·중단 복구 모두 원본 해시 동일, index·실제 selection 보존 |
| A2 실행기·개인 모드 | `locateConfig`(프로젝트 설정 우선 → `$E2E_RAIL_HOME/<메인 worktree 이름>/`) · 개인 원장 worktree 별 · `ledgerDir` resolve · 지문이 찾은 설정 파일을 해시 · `init --personal`(`.git/info/exclude`) · `bin/e2e-rail` PATH 심(레포 고정본 우선) · 스킬 명령 `e2e-rail <cmd>` 통일 | `test/personal.test.mjs` 11건 |
| A3 status | `e2e-rail status [--json]`: 설정·원장·codeId·앱별 모드 검증·`reach`(last-green 이후 E2E 가 닿는 파일)·선택·검토 | `test/status-review.test.mjs` |
| A4 검토 기록 | `select --review-done --reason` → `review{codeId, listSha, version}` · `--add`/코드 변경/버전 변경 시 stale · `run --selection` 이 `review:` 출력 · 재선택은 이월 안 함 | 같은 파일 6건 |
| A5 훅·autopilot | `e2e-rail hook turn-start|stop|post-bash` · Claude `hooks.json` 에 UserPromptSubmit·Stop·PostToolUse(Bash) · `skills/autopilot` · doctrine 0번 규칙 · `autopilot: false` 스위치 · Codex 는 SessionStart 유지 | `test/hook.test.mjs` 10건 · BFM 실레포 훅 1회 약 0.2초(쓰기 없음 측정) |

테스트: 단위 336/336 · Playwright 계약 4/4.

### 실대화 평가 (Claude Code 2.1.296 · `claude -p --plugin-dir` · 프롬프트에 스킬명 없음 · 샘플 앱 · 스텁 Playwright)

| 요청 | 기대 | 실제 |
| --- | --- | --- |
| Table 이 행 개수 +1 을 반환하게 바꿔줘 | 구현 뒤 E2E 흐름 자동 수행 | 수정 직후 에이전트가 스스로 `e2e-rail:autopilot` 호출 → status → select(no-base 전수) → gate → `run --full --mode preview` → `verify` verified → 고정 형식 보고. 14턴 · Stop 훅 차단 없음(이미 통과) |
| 위 요청 + «테스트는 돌리지 마» | 실행 안 함 · 미검증 명시 | 실행 안 함 → 첫 답에 E2E 줄 없음 → **Stop 훅 1회 차단** → `E2E: not verified — 사용자가 테스트를 돌리지 말라고 지시함` 추가 후 정지 |
| Table.ts 설명해줘 | 설정 변경·실행 없음 | 실행·차단 없음 · 3턴 |
| docs/overview.md 작성 | 실행 회피 | 실행·차단 없음 |

UserPromptSubmit 훅은 세션별 스냅샷 파일로 발화를 확인했다. 스트림에는 SessionStart 외 훅 이벤트가 나오지 않아, Stop 훅 발화는 «Stop hook feedback» 메시지로만 확인된다. 같은 세션에 `stop-hook-error` 알림이 하나 있었는데, 다른 전역 훅(SessionStart 에서 모듈 누락 오류를 낸 것)일 가능성이 높고 e2e-rail 훅은 항상 exit 0 이다(미확정).

미평가: Codex 실설치(사용자 Codex 미설치) · 실패 → 진단 → 수정 루프의 실대화 · 컨텍스트 압축 뒤 재개 · 여러 worktree 동시 세션. 한 번의 성공을 일반적 자동 호출 보장으로 해석하지 않는다.

### BFM 영향 (플러그인을 0.3.0 으로 올릴 때)
- BFM 메인 체크아웃에는 레포 루트 설정 복사본이 있어 **프로젝트 모드로 훅이 켜진다**. 코드를 바꾼 턴마다 실행이 없으면 Stop 훅이 한 번 묻는다. 라운드 운영(gate-lock · `pnpm e2e`)과 겹치면 설정에 `autopilot: false` 를 넣어 끈다.
- 개인 모드로 옮기려면 루트 복사본을 지우고 `~/.e2e-rail/bfm-fo-front/e2e-rail.config.mjs` 를 쓴다(이미 존재 · 2026-10-12 대조 결과 루트본과 내용 동일)
. `ledger: { dir: '.e2e-rail' }` 줄을 두면 기존 원장을 그대로 쓴다.

### 커밋 전 보안 보강 (커밋 보안 리뷰 2건 · 같은 날)
- **훅이 레포 설정(JS)을 권한 확인 없이 실행** → 훅은 명시적 e2e-rail 명령이 이 기계에서 같은 바이트를 이미 실행한 프로젝트 설정만 읽는다(`~/.e2e-rail/trusted-configs.json`). pull 로 바뀌면 다음 명시적 명령까지 훅은 조용하다. 개인 설정은 사용자 홈에 있어 기록이 필요 없다. 테스트: 설정에 표식 파일을 쓰는 코드를 심어 세 훅 모두 실행하지 않음을 확인.
- **PATH 심이 git 밖에서 `/` 까지 고정본을 찾음** → git 작업 트리 안에서 toplevel 까지만, `package.json` 이 e2e-rail 을 명시한 곳만 찾는다. 테스트: git 밖·미선언은 플러그인 사본.
- BFM 영향: 0.3.0 으로 올린 뒤 BFM 에서 명시적 e2e-rail 명령을 한 번 돌리기 전까지 훅은 조용하다.

### 0.3.1 보안 수정 (v0.3.0 푸시 뒤 커밋 보안 리뷰 3건)
- **신뢰 우회** — 설정 바이트만 기록하면 설정이 import 하는 파일은 덮이지 않는다 → 훅은 레포 코드를 전혀 실행하지 않는다. 명시 명령이 설정이 만든 데이터를 `~/.e2e-rail/recorded-configs.json` 에 sha256 과 함께 기록하고, 훅은 파일 바이트가 같을 때만 그 데이터로 설정을 다시 만든다.
- **링크 따라 삭제** — 레포가 `.e2e-rail/turns` 를 바깥 링크로 넣으면 주간 정리가 그곳 파일을 지웠다(테스트로 재현). 원장·turns 가 링크면 훅은 아무것도 안 하고, 자기 일반 파일만 정리하며, 심어 둔 링크는 지우고 새로 쓰고, 스냅샷 HEAD 는 전체 커밋 id 만 받는다(git 인자 주입 차단).
- **PATH 심의 레포 코드 실행** — 명시 명령은 원래 레포 코드(설정·TypeScript·Playwright)를 실행하므로 능력이 늘지는 않는다. 고정본으로 넘길 때 stderr 로 알리고 README 에 «무엇이 실행되나»를 적었다(수용 + 가시화).

### 0.3.2 보안 수정 (v0.3.1 커밋 보안 리뷰 1건)
- **중간 링크·경로 이탈** — 0.3.1 은 원장·turns 디렉터리 자체의 링크만 막았다. 상대 원장 경로(`state/.e2e-rail`)의 중간 디렉터리가 나중에 바깥 링크로 바뀌면 훅이 그곳에 쓰고 정리했다(테스트로 재현). 이제 상대 원장은 turns 의 실제 경로가 작업 트리 안일 때만 다룬다. 스냅샷 파일 키에 절대 경로나 `..` 가 있으면 읽지 않는다.

### 0.3.3 수정 (v0.3.2 외부 감사 4건 + Codex 검증 3건 · 2026-10-12 · Codex 최종 재검증 통과 뒤 릴리스)
감사 재현 스크립트(`/tmp/e2e-rail-v032-audit.qA0nyF/{probes,absolute-hook}.mjs`)를 CLI 경로만 바꿔 재실행: 샤드 1/2 → Stop 차단 · 같은 이름 저장소 → 분리 · 절대경로 원장 중간 링크 → 바깥 파일 보존 · 드릴(새 절차) → 실제 원장 그대로. 드릴을 변수 없이 돌리면 여전히 공유한다(같은 설정 + 절대경로 원장 = 같은 원장은 설계상 동작) → 절차로 막는다.

CHANGELOG 초안(범프 때 그대로 옮긴다):

```
## 0.3.3 — <date>

### Security

- **A hook touches the ledger only at the real path the recording command used.** 0.3.2 checked the real path of a
  relative ledger dir only; an absolute one inside the work tree could still be reached through a directory a later
  pull turns into a link, and the hook wrote and pruned there. Every explicit command now records the real path of the
  ledger dir with the config data (per config root), and a hook leaves the ledger alone unless it is still there.

- **Reading the Playwright version runs no dependency code.** It was `require('@playwright/test/package.json')`, which
  follows the package's `exports`: an entry mapping `./package.json` to JavaScript ran that code, and once the Stop
  check called `verify`, a hook could run it too. The version is now read from the package's own package.json as a
  file (looked for in `node_modules` of the app dir and its parents); one that is not JSON with a string `version`
  cannot be read, and nothing is verified.

### Fixes

- **The Stop check credits what verify credits.** It took any passing run of the code (one shard of several, an
  ad-hoc `--test-list` run, a worker measurement, a run of an older policy) as covering it. It now asks
  `verify --require selected` in each mode the code ran in: a full run, a complete shard set, or a run from a
  selection computed for this code.
- **Same-named repositories no longer share a personal config and ledger.** The personal dir is
  `<main worktree dir name>-<sha8 of the repository's real git directory>`. A config left at the 0.3.0–0.3.2 place
  (`~/.e2e-rail/<name>/`) is never read; the not-found error names it and the `mv` that moves it.
- **The machine lock works where the boot clock is denied.** In a macOS sandbox (Codex workspace-write) `os.uptime()`
  throws `uv_uptime returned EPERM`, and every locked run stopped before Playwright started. A lock record now carries
  the monotonic clock too, and a lock's age comes from the boot clock when both sides have it, else from the monotonic
  clock, else from the pid alone. Exclusion is unchanged; an orphan of a killed holder is still reaped there.
- **Codex shows the default prompts again.** Codex reads at most 3 (`ignoring interface.defaultPrompt: maximum of 3
  prompts is supported`); the list is autopilot, init and gate.
- **The seeded-failure drill forces its own ledger.** A copied config with an absolute `ledger.dir` named the real
  ledger, so the drill's `select` overwrote the real selection. `E2E_RAIL_LEDGER_DIR` moves the ledger for the commands
  it is set for; the drill exports it in every block and checks `e2e-rail status` before anything is selected.

### Upgrading

- Verification policy stays 2. Records made by 0.3.1–0.3.2 have no ledger path: run any e2e-rail command once per
  config and work tree, and the hooks work again. Personal configs: move `~/.e2e-rail/<name>/` as the error says.
```

#### Codex 실제 실행 검증 반영 (같은 날 · Codex CLI 0.154.0 · e2e-rail 0.3.2)
- 확인된 것: 일반 버그 수정 요청에서 스킬명 없이 autopilot 자동 호출 · 샌드박스 없음에서 status → select → run → verify 완료 · 코드 설명은 실행 없음 · «테스트하지 마» 는 미검증 명시. 데스크톱 UI 의 훅 신뢰·SessionStart 발화는 미평가.
- **workspace-write 샌드박스 락 실패** — `os.uptime()` 이 `uv_uptime returned EPERM` → 락 기록에 단조 시계(`mono`)를 함께 남기고, 나이는 부팅 시계 → 단조 시계 → pid 순으로 판단. 배타는 그대로. 테스트: `os.uptime` 을 막는 사전 로드로 자식 프로세스를 띄워 배타·고아 회수·이전 부팅 판정 확인. 수정 전 코드(a47ac0c)는 같은 조건에서 rc 1 · `uv_uptime ... EPERM`, 지금은 rc 0.
- **Codex 기본 프롬프트 4개 → 무시됨** — 3개(autopilot·init·gate)로 줄임. 실제 Codex 로더 재확인은 하지 않았다(Codex 쪽 재검증 필요).

#### Codex 재검증 반영 (같은 날 · 미커밋 수정본 대상)
- 해결 확인(Codex): 기존 6건 · workspace-write 자동 E2E 2개 통과 → verify · 기본 프롬프트 경고 사라짐.
- **새 회귀** — Stop 훅이 `verify` 를 부르면서 `playwrightVersion` 의 `require('@playwright/test/package.json')` 이 패키지 `exports` 를 따라 JS 를 실행할 수 있었다(0.3.2 훅은 verify 를 안 불러 해당 없음). → 패키지 루트 package.json 을 파일로 읽고(앱 디렉터리와 상위의 `node_modules`), JSON·문자열 version 이 아니면 읽기 실패로 처리. 회귀 테스트 2층(유틸 · 훅).

#### Codex Desktop 훅 신뢰·SessionStart 검증 (2026-10-12 · v0.3.3)

이 항목은 위의 «데스크톱 UI 훅 신뢰·SessionStart 발화 미평가»를 대체한다. **사용자의 데스크톱 훅 신뢰 처리와 신뢰 후 새 채팅의 doctrine 주입을 확인했다.**

- 대상: `v0.3.3`, commit `9f97c79eae8a6cf5ddba12df6a68d4d42244c0b0` (원격 main 및 annotated tag가 같은 커밋). 공식 CLI로 Git marketplace를 `--ref v0.3.3`에 고정해 설치했다. 설치된 Codex 패키지 10개 파일은 해당 소스와 바이트 단위로 일치했다.
- 실제 실행 환경: 세션 기록의 `originator: Codex Desktop`, `cli_version: 0.162.0-alpha.17.2`, `source: vscode`. 이전 `codex exec` CLI 0.154.0 평가와 별개다.
- 설치 직후: 플러그인은 `enabled = true`, e2e-rail 훅 신뢰 항목은 없었다. 첫 새 채팅은 여섯 스킬을 발견했지만 developer context에 doctrine이 없었고, 파일·도구를 읽지 않은 모델도 «SessionStart doctrine 미주입»으로 응답했다.
- 신뢰 처리: 사용자가 데스크톱에서 직접 처리했다고 확인했고, 설정에 `e2e-rail@e2e-rail-codex:hooks/hooks.json:session_start:0:0`의 `trusted_hash`가 생긴 것을 읽어 검증했다. UI 자동화는 Codex 앱 접근을 안전 정책으로 차단했으므로 버튼 조작·화면 표시는 자동 검증하지 못했다. 신뢰 값을 직접 쓰거나 `--dangerously-bypass-hook-trust`를 사용하지 않았다.
- 신뢰 후: 같은 확인 요청으로 만든 두 번째 새 채팅의 **developer 메시지에 설치된 `hooks/doctrine.md` 전체가 주입**됐다. 모델은 파일·도구 실행 없이 0번(변경 후 E2E 자동 수행)과 1번(보고 전 verify) 규칙을 인식했다. 설치·스킬 발견만을 훅 발화로 간주한 결과가 아니다.

| 대조 | 데스크톱 채팅 ID | doctrine 개발자 메시지 | 판정 |
| --- | --- | --- | --- |
| 설치 후·신뢰 전 | `01a12eca-46e5-7813-b8af-b6b5e4ef1067` | 없음 | 미신뢰 훅 미주입 확인 |
| 신뢰 후·새 세션 | `01a12ecb-6772-7e90-a504-a0e1c9d11c6c` | 전체 본문 일치 | SessionStart 실제 주입 통과 |

증거는 로컬 `~/.codex/sessions/2026/10/12/`의 해당 ID `rollout-*.jsonl`과 `~/.codex/config.toml`의 플러그인 활성화·훅 신뢰 항목이다. 사용자 설정/세션 원문은 저장소에 복사하지 않았다. 검증 후 플러그인 0.3.3 설치·활성화·신뢰와 marketplace의 `v0.3.3` 고정을 유지한다(사용자 승인 범위).

범위: 새 데스크톱 세션의 SessionStart 주입까지 통과. UI 버튼/경고의 시각적 검증, resume/compact 재주입, 실제 브라우저 E2E 및 모든 작업에서의 autopilot 자동 호출 보장은 이번 평가에 포함하지 않았다. 신뢰한 훅이 주입되는 것과 모델이 항상 규칙을 준수하는 것은 별도다. 설치 후 신뢰가 필요하다는 계약은 [공식 Hooks 문서](https://learn.chatgpt.com/docs/hooks)와 일치한다.

#### 락 테스트 간헐 실패 원인 확정 (2026-10-12 · 테스트만 수정 · 버전 그대로)
- 증상: «a holder killed with SIGKILL leaves an orphan the next acquire reaps» 가 전체 실행 1회에서 5,343ms 로 실패(획득 한도 5초).
- 원인: 테스트가 `lockStatus` 에 heavy 가 보이자마자 SIGKILL 한다. 보유자가 아직 자기 대기 티켓을 지우는 중(소유자 기록을 옆으로 옮긴 뒤, 디렉터리 삭제 전)이면 소유자 없는 티켓이 남고, 설계상 10초 유예(`OWNERLESS_GRACE_MS`) 동안 다음 요청을 막는다. 0.2.3(대기 티켓 도입 `63c2bfe`)부터 있던 경합이며 0.3.3 시계 변경과 무관하다(죽은 pid 는 시계 판단 전에 끝난다).
- 근거: 그 상태를 직접 만들면 5초 한도 실패 · 고부하에서 «보이자마자 종료» 300회 중 1회 재현 · `held` 출력 뒤 종료 300회 중 0회.
- 조치: 두 테스트가 보유자의 `held`(acquire 반환 = 티켓 삭제 완료)를 기다린 뒤 종료한다. 제품 동작(정확히 그 순간 죽으면 다음 실행이 최대 10초 더 기다림)은 만드는 중인 락을 보호하는 설계의 부작용으로 두었다. 전체 스위트 3회 350/350.
