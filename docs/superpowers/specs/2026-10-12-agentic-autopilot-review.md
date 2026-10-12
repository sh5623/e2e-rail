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
