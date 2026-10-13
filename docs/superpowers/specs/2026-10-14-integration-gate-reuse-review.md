# e2e-rail 통합 게이트 비용 개선 — 교차검증 판정

작성일: 2026-10-14 KST · 검토: Claude (Opus 5.5, Claude Code) · 대상: [통합 게이트 비용 개선 보고서](./2026-10-14-integration-gate-reuse-handoff.md)(Codex 작성)
기준: e2e-rail 0.3.3 `4ca1a82` · 결과: 판정 + 0.4.0 구현(측정 + 락 대기 중 동일 실행 합류)

검토 범위: 보고서 전문, `src/{run,ledger,verify,fingerprint,lock,measure,select}.mjs`, `src/util/git.mjs`, 스킬 3종
(autopilot·gate·measure), 그리고 **사용자 개인 BFM 원장 실물**(`bfm-fo-front/.e2e-rail/ledger.jsonl` 28줄 ·
`shadow.jsonl` · `selections/`, 2026-10-09~10-13). 원장은 읽기만 했다. 독립 모델 2개 검토는 하지 않았다: 작성은 Codex,
판정은 Claude 한 번이며, 판정 근거는 아래의 코드 위치와 실측값이다.

## 0 결론

| 단계 | 판정 | 이유 한 줄 |
| --- | --- | --- |
| 0 측정 | **채택(축소)** | 실행별 시간 분해와 «재사용으로 아낄 수 있었던 전수» 집계는 다음 단계의 착수 조건이다. 유닛·build·entry 합산은 프로젝트 게이트 실행기 몫이라 코어에 넣지 않는다 |
| 1A 동일 실행 중복 제거 | **수정 후 채택** | 새 실행 레지스트리·owner token·세대 번호 대신 **기존 머신 락(FIFO 번호표) + append-only 원장**으로 같은 성질을 얻는다. 필요한 변경은 «원장 줄을 쓴 뒤 락을 놓는다» 하나다 |
| 1B 통합 후보 고정·큐 | **보류** | 에픽에 쓰는 주체·Git 쓰기 소유권은 e2e-rail 밖(BFM 라운드 운영)이다. 코어에 둘 최소 구현이 없다 |
| 2 동일 입력 재사용 | **보류** | BFM 전수 17회 중 «같은 트리·다른 HEAD» 0회. 수요가 생기면 `measure time` 이 센다 |
| 3 통합 영향 분석 | **보류(대부분 이미 있음)** | 상류 이동 재게이트는 기존 `select --base <통과 head>`(두 점 diff)가 이미 «검증된 트리 → 후보 트리» 차이만 고른다. 실측 재게이트 2건 중 1건이 32 spec 부분 선택·섀도 hit. 막는 것은 BFM §11-A(사용자 결정)다 |
| 4 프로젝트 게이트 연결 | **보류** | 1B·3 이 보류라 연결할 대상이 없다 |

## 1 실측 (BFM 개인 원장, 0.4.0 `measure time` 과 같은 계산)

| 항목 | 값 |
| --- | --- |
| bfm 전수(필터 없음) | 17회 · Playwright 합계 254분 · 실패 2 |
| 선택·재실행 | 6회 · 2분 |
| 이미 전수 통과한 코드를 다시 돈 전수(repeat after a pass) | **0** |
| 다른 커밋으로 이미 통과한 트리를 다시 돈 전수(same tree, other head) | **0** (17개 head 의 tree 가 전부 다름) |
| 같은 지문 전수 2회 | 1건 — 10-10 `53186a4a`: 첫 회 **실패** 뒤 원인 조사용 재실행(의도된 재실행, 낭비 아님) |
| 락 대기 기록 | 3회 3ms, 나머지는 `--no-lock`(라운드 gate-lock 아래) — e2e-rail 락 대기 실측 불가 |
| 통과 직후 60분 안에 다른 head 로 다시 돈 전수(상류 이동 재게이트) | 2건 · 33분: `181ea0a5→d67eac83` 선택 **full**(`tier-full:e2e/support/**`) · `f33bef4b→43768c71` 선택 **partial 32 spec**(변경 10파일) · 섀도 hit |

0.4.0 CLI 로 같은 원장을 다시 읽은 결과: `full runs: 17 · repeat after a pass: 0 (0ms) · same tree, other head: 0 (0ms)`.

해석: 이 저장소의 비용은 «같은 것을 두 번»이 아니라 «상류가 움직여 내용이 바뀐 후보를 다시 전수»에서 나온다. 그 경우의
축소 수단은 이미 있고(`select --base last-green` → 선택 실행, 2026-10-14 승격으로 `trust selected`), 남은 장벽은 BFM
프로젝트 규약이다. 단계 2 의 입력 manifest 와 단계 3 의 U/R/F/E 기계는 이 원장에서 아낄 시간이 0 이거나, 기존 경로와
같은 일을 한다.

## 2 질문별 판정

### Q1 동일 요청 중복 실행 경로와 빈도 — **수정 후 채택**
- 경로 ①(이미 끝난 동일 코드): autopilot step 0 `status` 와 gate step 0 `verify --require full` 이 이미 막는다
  (`skills/autopilot/SKILL.md` §0, `skills/gate/SKILL.md` §0). 실측 0회.
- 경로 ②(진행 중인 동일 실행 뒤에서 대기): 같은 체크아웃의 두 세션(Claude Stop 훅 + Codex, 또는 사람 + 에이전트)이 같은
  코드에 `run --full` 을 걸면 두 번째가 heavy 락을 기다렸다가 같은 전수를 한 번 더 돈다. 기존 `verify` 로는 막지 못한다:
  요청 시점에는 결과가 없다. 0.3.3 은 또 **원장 줄을 쓰기 전에 락을 놓아**(`held.release()` 가 `appendRun` 앞) 대기자가
  결과보다 먼저 들어왔다. 실측 빈도는 0 이지만(BFM 은 워크트리마다 원장이 따로이고 라운드 전수는 `--no-lock`), 비용이 전수
  한 번(15분)이라 1회만 일어나도 구현 비용을 넘는다.
- 결정: 0.4.0 W1 — 락을 잡은 직후 원장에서 «이 요청 이후에 끝난, 같은 요청 키의, 중단되지 않은 실행»을 찾으면 실행하지
  않고 그 줄과 rc 를 돌려준다(`src/run.mjs` `finishedWhileWaiting` L305). 락은 원장 줄을 쓴 뒤 놓는다.

### Q2 큐를 코어와 조정자에 나누는 경계 — **채택(코어 쪽 최소 구현만)**
- 코어: 같은 머신·같은 원장의 동일 요청 합류(W1). 이미 있는 FIFO 번호표(`src/lock.mjs` L238 `ourTurn`)가 «A+B 검사 중 C
  도착 → C 는 뒤로»를 보장하므로 새 큐가 필요 없다.
- 조정자: 후보 편성, 에픽 쓰기 소유권, push 직전 base 재확인. 에픽에 쓰는 주체를 통제하지 못하면 코어가 할 수 있는 최소는
  «후보가 바뀌면 이전 결과로 통과시키지 않는다»인데, 지문(`head` 포함)이 이미 그 일을 한다. 1B 는 BFM 라운드 런북의 일이다.

### Q3 요청 키가 build 전후·옵션·환경을 구분하는가 — **수정**
- 보고서의 «요청 키만으로 build 전 통과 선언 금지»는 맞다. W1 은 **락을 잡고, 필요하면 빌드하고, 지문을 다시 계산한 뒤**
  비교한다. 지문에 dist 해시(preview)·configs·Playwright 버전·HEAD·미커밋 diff·untracked 가 들어 있으므로 build 전후 차이와
  대기 중 코드 변경은 지문이 가른다(테스트: 대기 중 `src/main.ts` 수정 → 합류 안 함).
- 키에 넣은 것: app·mode·kind·지문 id·selectionId·testListSha·shard·project·workers·blob·passthrough(받은 그대로).
  workers 는 검증 의미를 바꾸지 않지만 «다르면 공유하지 않는다»는 보수 쪽을 택했다.
- 환경: `run.env`·`modeEnv` 는 설정 파일 해시(지문 `config`)에 들어간다. 프로세스 환경 변수(예: BFM 의
  `VITE_API_PROXY_TARGET`)는 지문에 없다 — **기존 verify 와 같은 한계**이고, 합류는 «대기 시작 뒤에 끝난» 실행만 받으므로
  창이 몇 분으로 좁다. 이 한계는 README Limits 의 «gitignored 입력» 항과 같은 성격이라 새 항을 만들지 않았다.
- 후보 불변성: 보장하지 않는다(보고서 §3-5 와 같음). 실행 중 바뀌었다 돌아온 상태(ABA)는 지문이 못 본다.

### Q4 트리가 같아도 결과가 다른 반례를 단계 2 가 거부하는가 — **보류(단계 2 자체 보류)**
- 반례 목록(commit SHA 주입 빌드, 설치 패키지, 외부 데이터)은 타당하다. 그러나 실측 수요가 0 이라 지금 거부 규칙을 만들
  이유가 없다. 현행은 지문에 `head` 가 있어 **같은 트리·다른 커밋은 언제나 재실행**이다 — 가장 보수적인 답이다.
- README Limits 에 «결과는 커밋을 넘어 재사용하지 않는다(빈 커밋·무변경 rebase 도 자기 실행 필요, 그 통과에서 낸 선택은
  0 spec)»를 명시했다. 빈 diff 의 선택이 0 spec 인 근거: `src/select.mjs` L201(spec·src 변경이 없으면 `narrow` 를 부르지
  않음 → alwaysRun 도 붙지 않음).

### Q5 테스트별 의존성 경계의 신뢰 범위 — **채택(현행 유지)**
- 정적 그래프로 부족한 영역은 이미 full 로 남는다: `tier-full`·`graph-shell`·`graph-unresolved`·`adapter-unresolved`·
  `unknown-root`. 실측 재게이트 1 이 `tier-full:e2e/support/**` 로 full 이 된 것이 그 예다. 새 경계를 만들 필요가 없다.

### Q6 spec 집계에서 사라지는 skip/expected failure 정보 — **보류(스키마 변경 불필요)**
- `parsePlaywrightReport`(L168)는 spec×project 로 접어 «일부 skip 이어도 passed»가 된다 — 사실이다. 그러나 테스트별 원자료는
  이미 **실행마다 `.e2e-rail/reports/<run-id>.json`(Playwright JSON 리포트 원본)으로 남는다**(BFM 28줄 = 리포트 28개 실측).
  단계 3 을 시작할 때 원장 스키마를 바꾸지 않고 이 리포트를 읽으면 된다. 지금 원장 줄을 키울 이유가 없다.

### Q7 AI 분석이 검토 비용보다 큰 절감을 주는가 — **보류**
- 실측 재게이트 2건에서 기계 계산만으로 하나는 full(정당), 하나는 32 spec 부분 선택 + 섀도 hit 였다. 기존 impact-analyst
  (추가만, 제거 불가)가 이미 «숨은 결합 → 확대» 역할을 한다. 두 번째 모델 호출 조건을 정할 근거 표본이 없다.

### Q8 새 스키마가 verify·shard·shadow·last-green 의미를 바꾸지 않는가 — **채택(0.4.0 에서 확인)**
- 합류는 **원장에 아무것도 쓰지 않는다** — 새 `kind: full` 줄도, 복사본도 없다. verify·shard set·shadow·last-green 은 원래
  실행의 한 줄만 본다. 검증 정책 `VERIFY_POLICY` 는 2 그대로다.
- 새 필드(`blob`·`passthrough`·`build`·`wallMs`)는 추가뿐이다. 0.3.x 줄에는 passthrough 가 없어 합류 대상이 아니다(혼합
  버전에서 거짓 합류 없음). 0.3.x 대기자는 0.4.0 실행 뒤에서도 그냥 다시 돈다(현행 유지).
- 바뀐 관찰값 하나: `lock.releasedAt` 이 «원장 줄을 쓴 시각»이 됐다(직후 해제).
- 기존 스위트 350개 전부 그대로 통과(락·verify·shard·shadow·hook 포함).

### Q9 BFM §11-A 의 유지·수정 조건 — **채택(e2e-rail 쪽 변경 없음)**
- 유지: 합본 전수 1회. 0.4.0 은 이것을 건드리지 않는다.
- 나중에 사용자가 정할 것: 상류 이동 재게이트를 «마지막 통과 head 에서 `select` → 선택 실행»으로 줄일지. 근거 데이터는 위
  §1(2건 중 1건 축소 가능, 섀도 streak 3/3 → 승격). 이 판정 문서는 BFM 규약을 바꾸지 않는다.
- 과장 방지: `measure time` 은 Playwright·락 대기·빌드만 잰다. BFM 실측(재게이트 501초 중 유닛 409초)처럼 유닛이 지배하는
  후보에서 E2E 절감을 게이트 절감으로 보고하지 않는다 — measure 스킬 §0 에 «측정한 절감만 보고» 를 넣었다.

### Q10 다른 사용자·머신 증거의 신뢰 경계 — **채택(받지 않는다)**
- 합류는 이 작업 트리의 원장만 읽는다(`config` 의 ledger dir). 머신 락은 기계 공용이지만, 다른 저장소의 실행이 끝나도 이
  원장에는 줄이 없으므로 합류하지 않는다(같은 basename 저장소 혼동 없음 — 개인 모드 디렉터리는 0.3.3 부터 실제 git 디렉터리
  해시로 갈린다). 다른 머신·CI 증거 교환은 만들지 않았다.

## 3 0.4.0 에 들어간 것

| 무엇 | 위치 | 검증 |
| --- | --- | --- |
| W1 대기 중 동일 실행 합류 | `src/run.mjs` `requestKey`·`finishedWhileWaiting`, `src/commands/run.mjs` `reused:` 줄 | 단위 3(생산자 1회·추종자 2·실패 전달 / 다른 workers·passthrough·blob·대기 중 코드 변경은 합류 안 함 / 중단(130)·요청 전 종료·rerun·measure 는 안 받음) · CLI 1 · **실제 Playwright 계약 1** |
| 원장 줄을 쓴 뒤 락 해제 | `src/run.mjs` | 위 계약 테스트(추종자가 원장 줄을 봄) |
| 원장 필드 `blob`·`passthrough`·`build`·`wallMs` | `src/run.mjs` | 단위 1(dev·blob·preview 빌드·재빌드 없음) |
| `measure time` | `src/measure.mjs` `timeRows`·`reuseDemand`, `src/util/git.mjs` `gitTreeOf` | 단위 2(unknown ≠ 0, 반복·같은 트리·clone 밖 head) · CLI 1 · BFM 실물 원장 읽기 |

변이 검사(구현을 일부러 망가뜨려 테스트가 잡는지): 요청 키에서 workers·blob·passthrough 제거, 요청 시각 조건 제거,
중단 실행 수용, rerun·measure 합류 허용 — 4개 모두 해당 테스트가 실패했다.

테스트: 단위 358(기존 350 + 8) · 실제 Playwright 계약 5(기존 4 + 1). 문서: README·README.ko(락 절 «같은 실행에 합류»·
«시간», Limits 1항), CHANGELOG 0.4.0, 스킬 gate·autopilot·measure·init(+ Codex 미러).

## 4 보류 항목의 재개 조건

- 단계 2: `measure time` 의 `same tree, other head` 가 0 이 아니게 되고 그 시간이 전수 1회 이상일 때.
- 단계 3 / BFM 재게이트: 사용자가 §11-A 의 상류 이동 재게이트를 선택 실행으로 바꾸기로 정할 때. e2e-rail 쪽 추가 구현 없이
  `select --base <마지막 통과 head>` → `run --selection` → `verify --require selected` 로 된다.
- 1B: 에픽에 쓰는 주체가 하나로 정해질 때(그 전에는 non-fast-forward 거부가 최종 방어선).

자가개선: 해당 없음. e2e-rail 저장소의 신규 기능·판정 기록이며 BFM 규약을 바꾸지 않았다.
