# AiEAS 가상 자료 세트 (app/fixtures/)

본 디렉터리의 모든 자료는 실제 기관이나 인물과 무관하며 전적으로 가상으로 구성된 시험용 자료입니다. (RQ-24)
협력기관이 제공한 실제 자료나 그 마스킹본은 이 저장소 어디에도 포함되어 있지 않습니다.

## 파일 목록

- `01_project_plan.hwpx`: 가상 사업 사업계획서 파일 (지어낸 자료)
- `02_pdm.docx`: 가상 사업 성과관리표(PDM) 문서 파일 (지어낸 자료)
- `03_trip_report.pdf`: 가상 사업 현지 출장결과보고서 파일 (지어낸 자료)
- `04_review_opinion.docx`: 가상 사업 심사 의견 및 반영비교표 파일 (지어낸 자료)
- `05_other_project.docx`: 다른 사업 완료보고서 함정 파일 (지어낸 자료)
- `06_personal_memo.pdf`: 개인 여비 정산 신청서 함정 파일 (지어낸 자료)
- `07_empty.pdf`: 텍스트 레이어가 없는 읽지 못함 함정 파일 (지어낸 자료)
- `08_irrelevant_note.docx`: 사업명과 기간이 없는 무관 문서 함정 파일 (지어낸 자료)
- `answers.json`: 가상 사업 정답표 및 분류/함정 기준 파일 (지어낸 자료)
- `build.ts`: 가상 자료 생성 및 재현 스크립트 파일 (지어낸 자료)
- `README.md`: 가상 자료 목록 및 자료 경계 안내 문서 (지어낸 자료)

`answers.json`의 `read_status`는 파일에서 텍스트를 읽었는지 나타냅니다. 값은
`"추출 완료"` 또는 `"읽지 못함"`이며, 생략하면 `"추출 완료"`로 간주합니다.
`"읽지 못함"`은 RQ-05 기본 제외 사유와 별도 상태이므로 제외 이유를 붙이지
않습니다. 이 자료 세트에서 RQ-05 기본 제외 문서는 `05_other_project.docx`,
`06_personal_memo.pdf`, `08_irrelevant_note.docx`입니다.

## 함정 목록 (6종 각 1건 이상 포함)
1. 문서끼리 수치 충돌: 사업계획서 80% vs 성과관리표 5점 척도 3.5점
2. 근거 없는 판단: PDM 지표 중 성과 근거가 없는 디지털 법제 정비율 지표
3. 다른 사업 자료 섞임: 05_other_project.docx (기본 제외 대상)
4. 개인 서류 섞임: 06_personal_memo.pdf (기본 제외 대상)
5. 인용 금지 문장: 03_trip_report.pdf 2쪽 "이름을 밝히지 말아 달라고 요청" 문장
6. 텍스트 없는 파일: 07_empty.pdf (읽지 못함 상태 판정)
+ 무관 문서: 08_irrelevant_note.docx (사업명·기간 둘 다 없음, 기본 제외 대상)

## W-06 옛 한글·옛 워드 견본

- \`legacy/\`: W-06 옛 한글·옛 워드 견본 폴더 (지어낸 자료)
- \`legacy/09_legacy_minutes.hwp\`: 문단 추출용 옛 한글 회의록 (지어낸 자료)
- \`legacy/10_legacy_minutes_password.hwp\`: 암호가 걸린 옛 한글 회의록 (지어낸 자료)
- \`legacy/11_legacy_minutes_corrupt.hwp\`: 앞 600바이트만 남긴 손상 옛 한글 회의록 (지어낸 자료)
- \`legacy/12_legacy_table.hwp\`: 2×2 표를 포함한 옛 한글 회의록 (지어낸 자료)
- \`legacy/13_legacy_minutes.doc\`: 다섯 문단이 있는 옛 워드 회의록 (지어낸 자료)
- \`legacy/13_legacy_minutes.html\`: .doc 변환에 쓰는 가상 HTML 원본 (지어낸 자료)

\`legacy/13_legacy_minutes.doc\`는 \`legacy/13_legacy_minutes.html\`에서 만들었습니다.
\`app/\` 디렉터리에서 실행하는 변환 명령:
\`soffice --headless --convert-to 'doc:MS Word 97' --outdir fixtures/legacy fixtures/legacy/13_legacy_minutes.html\`
\`build.ts\`는 HWP 견본을 생성하며 기존 정답표 기반 8개 자료는 계속 루트에 둡니다.

## W-17 온톨로지 가상 자료 (지어낸 자료)

가상 옵시디언 볼트 구조와 검사기 사례입니다. 아래 파일은 모두 지어낸 자료이며, `invalid/`의 노트는 검사 실패를 재현합니다.
- `w17-stage3/source-document.json`: 인용 대조·신뢰 표시·원문 보기 API용 가상 문단 (지어낸 자료)
- `w17-stage4/ontology-graph.json`: 5열 계획 분류·SVG 그래프·요인 배치·텍스트 이스케이프용 가상 온톨로지 (지어낸 자료)
- `ontology/10_Sources/VA01/SRC-VA01-K001-01_가상문서A.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/10_Sources/VB01/SRC-VB01-K001-01_가상문서B.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/20_Snippets/VA01/SNP-VA01-K001-001.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/20_Snippets/VB01/SNP-VB01-K001-001.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/30_Entities/사업/P1_VA01.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/30_Entities/사업/P2_VB01.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/30_Entities/산출물/OPT-VA01-K001-01_가상산출물A.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/30_Entities/산출물/OPT-VB01-K001-01_가상산출물B.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/30_Entities/성과/OUT-M-VA01-K001-01_가상성과A.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/30_Entities/성과/OUT-M-VB01-K001-01_가상성과B.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/30_Entities/수행기관/가상수행기관_공용.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/30_Entities/정책분야/가상정책분야_공용.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/30_Entities/지표/IND-VA01-K001-01_가상지표A.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/30_Entities/지표/IND-VB01-K001-01_가상지표B.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/30_Entities/협력국/가상협력국_공용.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/30_Entities/활동/ACT-VA01-K001-01_가상활동A.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/30_Entities/활동/ACT-VB01-K001-01_가상활동B.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/50_Projects/VA01/VA01_가상보고서A.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/50_Projects/VB01/VB01_가상보고서B.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/invalid/evidence-notices/SNP-ZZ-ZZZ-004.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/invalid/evidence-notices/SRC-ZZ-ZZZ-01_일반.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/invalid/evidence-source/SNP-ZZ-ZZZ-001.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/invalid/evidence-source/SNP-ZZ-ZZZ-003.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/invalid/evidence-source/SRC-ZZ-ZZZ-99_보류.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/invalid/list-link/OPT-ZZ-ZZZ-01_끊긴링크.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/invalid/name-id-date/잘못된 이름[검수].md`: 공백·대괄호 파일명 검사 사례 (지어낸 자료)
- `ontology/invalid/no-evidence/OPT-ZZ-ZZZ-03_근거없음.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/invalid/outcome-state/OUT-M-ZZ-ZZZ-01_상태오류.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/invalid/outcome-state/SNP-ZZ-ZZZ-002.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/invalid/report-footnote/보고서.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/invalid/report-footnote/SNP-ZZ-ZZZ-001.md`: 번호가 맞지 않는 각주 대상 시험용 근거 (지어낸 자료)
- `ontology/invalid/unquoted-date/ACT-ZZ-ZZZ-01.md`: 따옴표 없는 YAML 날짜 검사 사례 (지어낸 자료)
- `ontology/invalid/required-fields/OUT-M-ZZ-ZZZ-01_필수칸누락.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/invalid/required-vocab/ACT-ZZ-ZZZ-01_통제값.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/invalid/review-authority/OPT-ZZ-ZZZ-02_확정검토.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/invalid/no-evidence/FAC-C-ZZ-ZZZ-01_근거없는제약요인.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/invalid/no-evidence/FAC-E-ZZ-ZZZ-01_근거없는기여요인.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/invalid/no-evidence/OUT-M-ZZ-ZZZ-02_근거없는중장기성과.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
- `ontology/invalid/no-evidence/OUT-S-ZZ-ZZZ-01_근거없는단기성과.md`: W-17 온톨로지 가상 자료 (지어낸 자료)
