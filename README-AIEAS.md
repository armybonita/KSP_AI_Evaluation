# 아이어스(AiEAS) 앱 코드

종료평가 지원 앱 아이어스의 앱 코드 사본입니다(`app/`). 넥스테인 아이어스 저장소의 2026-11-03 판(ca221dc)에서 앱 폴더만 옮겼습니다. 시험 자료(`app/fixtures/`)는 모두 지어낸 가상 자료입니다.

## 화면 흐름

사업 목록 → ① 자료 올리기 → ② 지식 지도(문서에서 활동·산출물·성과·요인·지표 점 만들기) → ③ 자료 규칙 → ④~⑦ 묶기·판정(산출물·단기성과·중장기성과·기여/제약요인, 근거 문단·신뢰수준·단계) → ⑧ 보고서 → ⑨ 사업 모음.

## 실행

Node.js 22, npm 이 필요합니다.

```bash
cd app
npm ci
npm run migrate        # SQLite 데이터베이스 준비
npm run dev            # http://localhost:3000
```

배포용은 `npm run build` 뒤 `npm run start`.

## 환경 값

| 이름 | 뜻 |
|---|---|
| `AIEAS_DB_PATH` | SQLite 파일 위치 |
| `AIEAS_UPLOAD_DIR` | 올린 문서 저장 폴더 |
| `AIEAS_AI_PROVIDER` | AI 제공자 (예: `solar`) |
| `AIEAS_LLM_BASE_URL`, `AIEAS_LLM_API_KEY` | AI 호출 주소와 키 (키는 저장소에 넣지 않습니다) |
| `AIEAS_MODEL`, `AIEAS_REASONING_EFFORT` | 모델 이름과 추론 강도 (예: `solar-pro4`, `xhigh`) |
| `AIEAS_AI_CALL_TIMEOUT_MS`, `AIEAS_ONTOLOGY_BATCH_TIMEOUT_MS` | AI 호출·덩어리 시간 제한 |
| `AIEAS_ONTOLOGY_CONCURRENCY`, `AIEAS_ONTOLOGY_PARAGRAPHS_PER_REQUEST` | 지식 지도 동시 호출 수, 한 번에 보내는 문단 수 (개발 서버 2, 8) |
| `AIEAS_SYNTHESIS_MAX_MS` | 묶기·판정 전체 시간 상한 (기본 45분, 개발 서버 2시간) |
| `AIEAS_AUTH_MODE`, `AIEAS_ROLE_MAP` | 로그인 방식과 역할 배정 |
| `AIEAS_E2E_FAKE_AI` | 시험용 가짜 AI 응답 |

## 시험

```bash
npm run typecheck && npm run lint && npm run test:unit
npx playwright test    # 화면 시험(e2e)
```

## 주요 폴더

- `src/server/ontology/` 지식 지도 생성(`generator`)과 묶기·판정(`synthesis`)
- `src/server/extract/` Word·한글·PDF 문서 읽기
- `src/lib/baseline-key.ts` 성과관리표(PDM) 표 해석
- `src/server/report/` 보고서
- `src/server/quote-verify/`, `src/server/numeric-check/` 인용 대조·숫자 근거 검사(근거에 없는 숫자는 쓰지 않음)
