import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import * as store from '../src/server/store';

describe('확정 이력 단위 시험 (RQ-17, RQ-18, RQ-19, D13, D16, D44)', () => {
  let tempDbPath: string;
  let db: ReturnType<typeof store.openDatabase>;
  const PROJECT_ID = 'proj-test-confirm';
  const INDICATOR_ID = 'ind-test-1';
  const INDICATOR_ID_2 = 'ind-test-2';
  let initialProposal1: string;
  let initialProposal2: string;

  beforeEach(() => {
    tempDbPath = path.join(
      os.tmpdir(),
      `aieas-confirm-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`
    );
    db = store.openDatabase(tempDbPath);

    initialProposal1 = `AI 최초 제안 1 [${crypto.randomUUID()}]`;
    initialProposal2 = `AI 최초 제안 2 [${crypto.randomUUID()}]`;

    // 기본 프로젝트 및 지표 생성
    store.createProject(
      {
        id: PROJECT_ID,
        name: '확정 이력 시험 사업',
        created_at: new Date().toISOString(),
      },
      db
    );

    store.createIndicator(
      {
        id: INDICATOR_ID,
        project_id: PROJECT_ID,
        level: '활동',
        name: '테스트 지표 1',
        ovi: '지표 정의',
        mov: '보고서',
        target_value: '100명',
        is_baseline: 0,
        created_at: new Date().toISOString(),
      },
      db
    );

    store.createIndicator(
      {
        id: INDICATOR_ID_2,
        project_id: PROJECT_ID,
        level: '산출물',
        name: '테스트 지표 2',
        ovi: '지표 정의 2',
        mov: '보고서 2',
        target_value: '200명',
        is_baseline: 0,
        created_at: new Date().toISOString(),
      },
      db
    );

    store.saveSuggestion(
      {
        id: 'sugg-test-1',
        indicator_id: INDICATOR_ID,
        verdict_status: '실현',
        error_reason: null,
        proposal_text: initialProposal1,
        created_at: '2026-10-09T09:00:00.000Z',
      },
      [],
      db
    );

    store.saveSuggestion(
      {
        id: 'sugg-test-2',
        indicator_id: INDICATOR_ID_2,
        verdict_status: '실현',
        error_reason: null,
        proposal_text: initialProposal2,
        created_at: '2026-10-09T09:00:00.000Z',
      },
      [],
      db
    );
  });

  afterEach(() => {
    store.closeDatabase();
    if (fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch {
        // 무시
      }
    }
  });

  describe('1. 추가만 (Append-only) 및 재확정 이력 누적 (RQ-18, D13)', () => {
    it('확정 기록을 추가할 수 있으며, 같은 지표에 3번 확정하면 3개의 이력 줄이 시간순으로 누적된다', () => {
      // 1회차: 확정
      store.createConfirmation(
        {
          id: 'conf-1',
          indicator_id: INDICATOR_ID,
          confirmation_type: '확정',
          confirmer_name: '평가자A',
          created_at: '2026-10-09T10:00:00.000Z',
        },
        db
      );

      // 2회차: 수정 후 확정
      store.createConfirmation(
        {
          id: 'conf-2',
          indicator_id: INDICATOR_ID,
          confirmation_type: '수정 후 확정',
          edited_text: '평가자 수정본 내용입니다.',
          reason: '수치 기준 정정',
          confirmer_name: '평가자B',
          created_at: '2026-10-09T11:00:00.000Z',
        },
        db
      );

      // 3회차: 보완 필요
      store.createConfirmation(
        {
          id: 'conf-3',
          indicator_id: INDICATOR_ID,
          confirmation_type: '보완 필요',
          confirmer_name: '평가자A',
          created_at: '2026-10-09T12:00:00.000Z',
        },
        db
      );

      const history = store.listConfirmations(INDICATOR_ID, db);
      expect(history.length).toBe(3);

      expect(history[0].id).toBe('conf-1');
      expect(history[0].confirmation_type).toBe('확정');
      expect(history[0].confirmer_name).toBe('평가자A');
      expect(history[0].initial_proposal).toBe(initialProposal1);

      expect(history[1].id).toBe('conf-2');
      expect(history[1].confirmation_type).toBe('수정 후 확정');
      expect(history[1].edited_text).toBe('평가자 수정본 내용입니다.');
      expect(history[1].reason).toBe('수치 기준 정정');
      expect(history[1].confirmer_name).toBe('평가자B');
      expect(history[1].initial_proposal).toBe(initialProposal1);

      expect(history[2].id).toBe('conf-3');
      expect(history[2].confirmation_type).toBe('보완 필요');
      expect(history[2].confirmer_name).toBe('평가자A');
      expect(history[2].initial_proposal).toBe(initialProposal1);
    });

    it('네 가지 확정 종류(확정, 수정 후 확정, 보완 필요, 채택 제외)가 모두 정상 등록된다', () => {
      const types: store.ConfirmationType[] = ['확정', '수정 후 확정', '보완 필요', '채택 제외'];

      for (let i = 0; i < types.length; i++) {
        const type = types[i];
        store.createConfirmation(
          {
            id: `conf-type-${i}`,
            indicator_id: INDICATOR_ID,
            confirmation_type: type,
            edited_text: type === '수정 후 확정' ? '수정본' : undefined,
            reason: type === '수정 후 확정' ? '사유' : undefined,
            confirmer_name: '평가자A',
            created_at: new Date(Date.now() + i * 1000).toISOString(),
          },
          db
        );
      }

      const history = store.listConfirmations(INDICATOR_ID, db);
      expect(history.length).toBe(4);
      expect(history.map((h) => h.confirmation_type)).toEqual(types);
    });
  });

  describe('2. "수정 후 확정" 유효성 검증 (RQ-17, UC-16)', () => {
    it('수정 후 확정은 수정본(edited_text)이 비어 있으면 저장 거부된다 (코드 레벨)', () => {
      expect(() => {
        store.createConfirmation(
          {
            id: 'conf-err-1',
            indicator_id: INDICATOR_ID,
            confirmation_type: '수정 후 확정',
            edited_text: '',
            reason: '수정 사유 있음',
            confirmer_name: '평가자A',
            created_at: new Date().toISOString(),
          },
          db
        );
      }).toThrow('수정 후 확정은 수정본이 비어 있을 수 없습니다.');

      expect(() => {
        store.createConfirmation(
          {
            id: 'conf-err-2',
            indicator_id: INDICATOR_ID,
            confirmation_type: '수정 후 확정',
            edited_text: '   ',
            reason: '수정 사유 있음',
            confirmer_name: '평가자A',
            created_at: new Date().toISOString(),
          },
          db
        );
      }).toThrow('수정 후 확정은 수정본이 비어 있을 수 없습니다.');
    });

    it('수정 후 확정은 사유(reason)가 비어 있으면 저장 거부된다 (코드 레벨)', () => {
      expect(() => {
        store.createConfirmation(
          {
            id: 'conf-err-3',
            indicator_id: INDICATOR_ID,
            confirmation_type: '수정 후 확정',
            edited_text: '수정본 있음',
            reason: '',
            confirmer_name: '평가자A',
            created_at: new Date().toISOString(),
          },
          db
        );
      }).toThrow('수정 후 확정은 사유가 비어 있을 수 없습니다.');

      expect(() => {
        store.createConfirmation(
          {
            id: 'conf-err-4',
            indicator_id: INDICATOR_ID,
            confirmation_type: '수정 후 확정',
            edited_text: '수정본 있음',
            reason: '   ',
            confirmer_name: '평가자A',
            created_at: new Date().toISOString(),
          },
          db
        );
      }).toThrow('수정 후 확정은 사유가 비어 있을 수 없습니다.');
    });

    it('DB 레벨 CHECK 제약조건으로도 수정 후 확정 빈 칸이 거부된다', () => {
      // raw INSERT 시도: edited_text 누락
      expect(() => {
        db.prepare(`
          INSERT INTO confirmations (
            id, indicator_id, confirmation_type, edited_text, reason, confirmer_name, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('raw-1', INDICATOR_ID, '수정 후 확정', null, '사유', '평가자', new Date().toISOString());
      }).toThrow(/CHECK constraint failed/);

      // raw INSERT 시도: reason 누락
      expect(() => {
        db.prepare(`
          INSERT INTO confirmations (
            id, indicator_id, confirmation_type, edited_text, reason, confirmer_name, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('raw-2', INDICATOR_ID, '수정 후 확정', '수정본', '', '평가자', new Date().toISOString());
      }).toThrow(/CHECK constraint failed/);
    });
  });

  describe('3. 확정자 이름 필수 및 D44 마지막 확정자 이름 조회 (D16, D44)', () => {
    it('확정자 이름이 비어 있거나 공백이면 저장이 거부된다', () => {
      expect(() => {
        store.createConfirmation(
          {
            id: 'conf-noname-1',
            indicator_id: INDICATOR_ID,
            confirmation_type: '확정',
            confirmer_name: '',
            created_at: new Date().toISOString(),
          },
          db
        );
      }).toThrow('확정자 이름은 비어 있거나 공백일 수 없습니다.');

      expect(() => {
        store.createConfirmation(
          {
            id: 'conf-noname-2',
            indicator_id: INDICATOR_ID,
            confirmation_type: '확정',
            confirmer_name: '   ',
            created_at: new Date().toISOString(),
          },
          db
        );
      }).toThrow('확정자 이름은 비어 있거나 공백일 수 없습니다.');
    });

    it('DB 레벨 CHECK 제약조건으로도 빈 확정자 이름이 거부된다', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO confirmations (
            id, indicator_id, confirmation_type, confirmer_name, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `).run('raw-noname', INDICATOR_ID, '확정', '  ', new Date().toISOString());
      }).toThrow(/CHECK constraint failed/);
    });

    it('getLatestConfirmerName 은 해당 사업에서 가장 최근에 입력된 확정자 이름을 반환한다 (D44)', () => {
      expect(store.getLatestConfirmerName(PROJECT_ID, db)).toBeUndefined();

      store.createConfirmation(
        {
          id: 'conf-c1',
          indicator_id: INDICATOR_ID,
          confirmation_type: '확정',
          confirmer_name: '홍길동',
          created_at: '2026-10-09T09:00:00.000Z',
        },
        db
      );
      expect(store.getLatestConfirmerName(PROJECT_ID, db)).toBe('홍길동');

      store.createConfirmation(
        {
          id: 'conf-c2',
          indicator_id: INDICATOR_ID_2,
          confirmation_type: '보완 필요',
          confirmer_name: '김평가',
          created_at: '2026-10-09T10:00:00.000Z',
        },
        db
      );
      expect(store.getLatestConfirmerName(PROJECT_ID, db)).toBe('김평가');
    });
  });

  describe('4. 최신 확정 조회 (getLatestConfirmation)', () => {
    it('여러 확정 기록 중 가장 최근에 등록된 확정을 정확히 반환한다', () => {
      expect(store.getLatestConfirmation(INDICATOR_ID, db)).toBeUndefined();

      store.createConfirmation(
        {
          id: 'conf-t1',
          indicator_id: INDICATOR_ID,
          confirmation_type: '확정',
          confirmer_name: '평가자1',
          created_at: '2026-10-09T08:00:00.000Z',
        },
        db
      );

      store.createConfirmation(
        {
          id: 'conf-t2',
          indicator_id: INDICATOR_ID,
          confirmation_type: '수정 후 확정',
          edited_text: '수정본',
          reason: '사유',
          confirmer_name: '평가자2',
          created_at: '2026-10-09T09:00:00.000Z',
        },
        db
      );

      const latest = store.getLatestConfirmation(INDICATOR_ID, db);
      expect(latest).toBeDefined();
      expect(latest!.id).toBe('conf-t2');
      expect(latest!.confirmation_type).toBe('수정 후 확정');
      expect(latest!.confirmer_name).toBe('평가자2');
    });
  });

  describe('5. DB 트리거로 UPDATE 및 DELETE 거부 (추가만 허용, RQ-18)', () => {
    it('DB 트리거가 UPDATE 명령을 감지하여 실행을 차단(ABORT)한다', () => {
      store.createConfirmation(
        {
          id: 'conf-immutable',
          indicator_id: INDICATOR_ID,
          confirmation_type: '확정',
          confirmer_name: '원작성자',
          created_at: new Date().toISOString(),
        },
        db
      );

      expect(() => {
        db.prepare(`UPDATE confirmations SET confirmer_name = ? WHERE id = ?`).run(
          '변조자',
          'conf-immutable'
        );
      }).toThrow(/확정 이력은 수정할 수 없습니다/);

      // 값이 변조되지 않았음을 단언
      const row = store.getLatestConfirmation(INDICATOR_ID, db);
      expect(row?.confirmer_name).toBe('원작성자');
    });

    it('DB 트리거가 DELETE 명령을 감지하여 실행을 차단(ABORT)한다', () => {
      store.createConfirmation(
        {
          id: 'conf-nodelete',
          indicator_id: INDICATOR_ID,
          confirmation_type: '확정',
          confirmer_name: '원작성자',
          created_at: new Date().toISOString(),
        },
        db
      );

      expect(() => {
        db.prepare(`DELETE FROM confirmations WHERE id = ?`).run('conf-nodelete');
      }).toThrow(/확정 이력은 삭제할 수 없습니다/);

      // 행이 삭제되지 않았음을 단언
      const row = store.getLatestConfirmation(INDICATOR_ID, db);
      expect(row).toBeDefined();
      expect(row?.id).toBe('conf-nodelete');
    });
  });

  describe('6. 저장 계층 수정·삭제 API 부재 검사 (체크리스트 요구사항)', () => {
    it('store 모듈에 이력 수정 및 삭제 함수가 존재하지 않는다', () => {
      const storeAny = store as Record<string, unknown>;

      expect(storeAny.updateConfirmation).toBeUndefined();
      expect(storeAny.updateConfirmations).toBeUndefined();
      expect(storeAny.deleteConfirmation).toBeUndefined();
      expect(storeAny.deleteConfirmations).toBeUndefined();
      expect(storeAny.removeConfirmation).toBeUndefined();
      expect(storeAny.modifyConfirmation).toBeUndefined();
    });

    it('db.ts 소스 코드에 confirmations 테이블에 대한 UPDATE 및 DELETE SQL 문이 없다 (트리거 제외)', () => {
      const dbTsPath = path.resolve(__dirname, '../src/server/store/db.ts');
      const dbContent = fs.readFileSync(dbTsPath, 'utf8');

      // db.ts 에 UPDATE confirmations 또는 DELETE FROM confirmations 가 없어야 함
      expect(dbContent).not.toMatch(/UPDATE\s+confirmations/i);
      expect(dbContent).not.toMatch(/DELETE\s+FROM\s+confirmations/i);
    });
  });

  describe('7. AI 제안 유무에 따른 확정 거부 및 최초 제안 불변 보존 (검수 결정 (a), (b))', () => {
    it('AI 제안이 하나도 없는 지표는 확정할 수 없다 (저장 모듈 에러 발생)', () => {
      const NO_SUGG_IND_ID = 'ind-no-sugg';
      store.createIndicator(
        {
          id: NO_SUGG_IND_ID,
          project_id: PROJECT_ID,
          level: '활동',
          name: '제안 없는 지표',
          ovi: 'OVI',
          mov: null,
          target_value: null,
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );

      expect(() => {
        store.createConfirmation(
          {
            indicator_id: NO_SUGG_IND_ID,
            confirmation_type: '확정',
            confirmer_name: '평가자',
          },
          db
        );
      }).toThrow('AI 제안이 없는 지표는 확정할 수 없습니다.');
    });

    it('제안 → 재제안 → 확정 시 최초 제안이 첫 제안임이 보존되고 각 줄마다 그 시점 최신 제안 id 가 남는다', () => {
      const IND_ID = 'ind-multi-sugg';
      store.createIndicator(
        {
          id: IND_ID,
          project_id: PROJECT_ID,
          level: '단기성과',
          name: '다중 제안 지표',
          ovi: 'OVI',
          mov: null,
          target_value: null,
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );

      const prop1 = `첫 번째 제안 [${crypto.randomUUID()}]`;
      const prop2 = `두 번째 재제안 [${crypto.randomUUID()}]`;
      const prop3 = `세 번째 재제안 [${crypto.randomUUID()}]`;

      // 제안 1 생성
      store.saveSuggestion(
        {
          id: 'sugg-multi-1',
          indicator_id: IND_ID,
          verdict_status: '실현',
          error_reason: null,
          proposal_text: prop1,
          created_at: '2026-10-09T01:00:00.000Z',
        },
        [],
        db
      );

      // 재제안 (제안 2 생성)
      store.saveSuggestion(
        {
          id: 'sugg-multi-2',
          indicator_id: IND_ID,
          verdict_status: '추진 중',
          error_reason: null,
          proposal_text: prop2,
          created_at: '2026-10-09T02:00:00.000Z',
        },
        [],
        db
      );

      // 1회차 확정: initial_proposal 넘기지 않아도 저장 모듈이 최초 제안으로 결정
      const conf1 = store.createConfirmation(
        {
          indicator_id: IND_ID,
          confirmation_type: '확정',
          confirmer_name: '평가자1',
          created_at: '2026-10-09T03:00:00.000Z',
        },
        db
      );

      expect(conf1.initial_proposal).toBe(prop1);
      expect(conf1.suggestion_id).toBe('sugg-multi-2'); // 확정 시점의 최신 제안 id

      // 추가 재제안 (제안 3 생성)
      store.saveSuggestion(
        {
          id: 'sugg-multi-3',
          indicator_id: IND_ID,
          verdict_status: '실현',
          error_reason: null,
          proposal_text: prop3,
          created_at: '2026-10-09T04:00:00.000Z',
        },
        [],
        db
      );

      // 2회차 재확정
      const conf2 = store.createConfirmation(
        {
          indicator_id: IND_ID,
          confirmation_type: '수정 후 확정',
          edited_text: '평가자 수정 문구',
          reason: '근거 보강',
          confirmer_name: '평가자2',
          created_at: '2026-10-09T05:00:00.000Z',
        },
        db
      );

      expect(conf2.initial_proposal).toBe(prop1); // 재제안이 있어도 최초 제안 불변
      expect(conf2.suggestion_id).toBe('sugg-multi-3'); // 2회차 확정 시점의 최신 제안 id

      // 이력 목록 확인
      const history = store.listConfirmations(IND_ID, db);
      expect(history.length).toBe(2);
      expect(history[0].initial_proposal).toBe(prop1);
      expect(history[0].suggestion_id).toBe('sugg-multi-2');
      expect(history[1].initial_proposal).toBe(prop1);
      expect(history[1].suggestion_id).toBe('sugg-multi-3');
    });
  });

  describe('8. 검수 2회차 반영: CreateConfirmationInput 제한 및 삽입 순서(rowid) 정렬', () => {
    it('CreateConfirmationInput 에서 suggestion_id 와 initial_proposal 은 Omit 되어 타입을 통해 넘길 수 없으며 오래된 id 가 무시된다', () => {
      // 1. 타입 레벨 단언: suggestion_id 와 initial_proposal 은 CreateConfirmationInput 의 키에 존재하지 않는다
      type HasSuggestionId = 'suggestion_id' extends keyof store.CreateConfirmationInput ? true : false;
      const hasSuggestionId: HasSuggestionId = false;
      expect(hasSuggestionId).toBe(false);

      type HasInitialProposal = 'initial_proposal' extends keyof store.CreateConfirmationInput ? true : false;
      const hasInitialProposal: HasInitialProposal = false;
      expect(hasInitialProposal).toBe(false);

      // @ts-expect-error suggestion_id 는 CreateConfirmationInput 에 포함되지 않는다
      const badInput1: store.CreateConfirmationInput = { indicator_id: INDICATOR_ID, confirmation_type: '확정', confirmer_name: '평가자', suggestion_id: 'old-suggestion-id' };
      expect(badInput1).toBeDefined();

      // @ts-expect-error initial_proposal 은 CreateConfirmationInput 에 포함되지 않는다
      const badInput2: store.CreateConfirmationInput = { indicator_id: INDICATOR_ID, confirmation_type: '확정', confirmer_name: '평가자', initial_proposal: 'stale-proposal' };
      expect(badInput2).toBeDefined();

      // 런타임 검증: 호출자가 구버전 제안 id 를 넘기려 시도해도, 저장 모듈은 이를 무시하고 최신 제안 id 를 기록한다
      const staleIdAttempt = {
        indicator_id: INDICATOR_ID,
        confirmation_type: '확정' as const,
        confirmer_name: '평가자A',
        suggestion_id: 'sugg-obsolete-id',
      };

      const conf = store.createConfirmation(
        staleIdAttempt as unknown as store.CreateConfirmationInput,
        db
      );

      // suggestion_id 는 staleIdAttempt 의 값이 아니라 실제 최신 제안 id 여야 한다
      expect(conf.suggestion_id).toBe('sugg-test-1');
      expect(conf.initial_proposal).toBe(initialProposal1);
    });

    it('가장 이른/최신 제안 판단은 created_at 이 아니라 삽입 순서(INTEGER 자동 증가 열 또는 rowid)로 한다 (같은 시각 두 제안 시험)', () => {
      const SAME_TIME_IND_ID = 'ind-same-time-test';
      store.createIndicator(
        {
          id: SAME_TIME_IND_ID,
          project_id: PROJECT_ID,
          level: '활동',
          name: '같은 시각 제안 지표',
          ovi: 'OVI',
          mov: null,
          target_value: null,
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );

      const fixedTimestamp = '2026-10-09T12:00:00.000Z';
      const proposalTextFirst = `동일시각 제안 1 [${crypto.randomUUID()}]`;
      const proposalTextSecond = `동일시각 제안 2 [${crypto.randomUUID()}]`;

      // 1번째 제안 삽입 (rowid 가 앞섬)
      store.saveSuggestion(
        {
          id: 'sugg-same-1',
          indicator_id: SAME_TIME_IND_ID,
          verdict_status: '실현',
          error_reason: null,
          proposal_text: proposalTextFirst,
          created_at: fixedTimestamp,
        },
        [],
        db
      );

      // 2번째 제안 삽입 (created_at 은 동일하지만 rowid 가 뒤임)
      store.saveSuggestion(
        {
          id: 'sugg-same-2',
          indicator_id: SAME_TIME_IND_ID,
          verdict_status: '추진 중',
          error_reason: null,
          proposal_text: proposalTextSecond,
          created_at: fixedTimestamp,
        },
        [],
        db
      );

      // rowid 기준 가장 이른 제안(최초 제안)은 1번째 삽입된 sugg-same-1 이어야 함
      const earliest = store.getEarliestSuggestion(SAME_TIME_IND_ID, db);
      expect(earliest).toBeDefined();
      expect(earliest!.id).toBe('sugg-same-1');
      expect(earliest!.proposal_text).toBe(proposalTextFirst);

      // rowid 기준 최신 제안은 2번째 삽입된 sugg-same-2 이어야 함
      const latest = store.getLatestSuggestion(SAME_TIME_IND_ID, db);
      expect(latest).toBeDefined();
      expect(latest!.id).toBe('sugg-same-2');
      expect(latest!.proposal_text).toBe(proposalTextSecond);

      // 확정 수행: 최초 제안은 제안1, 줄의 제안 id 는 최신 제안(sugg-same-2)이 자동으로 저장 모듈에 의해 결정됨
      const conf = store.createConfirmation(
        {
          indicator_id: SAME_TIME_IND_ID,
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );

      expect(conf.initial_proposal).toBe(proposalTextFirst);
      expect(conf.suggestion_id).toBe('sugg-same-2');

      const history = store.listConfirmations(SAME_TIME_IND_ID, db);
      expect(history.length).toBe(1);
      expect(history[0].initial_proposal).toBe(proposalTextFirst);
      expect(history[0].suggestion_id).toBe('sugg-same-2');
    });

    it("'수정 후 확정'에서 평가자가 판정 상태(edited_verdict_status)를 변경하여 저장할 수 있다 (#23 결정)", () => {
      // 제안 생성: AI 판정 = '추진 중'
      store.saveSuggestion(
        {
          id: 'sugg-edit-verdict-1',
          indicator_id: INDICATOR_ID,
          verdict_status: '추진 중',
          error_reason: null,
          proposal_text: '추진 중 제안입니다.',
          created_at: new Date().toISOString(),
        },
        [],
        db
      );

      // 수정 후 확정: 평가자가 판정을 '실현'으로 변경
      const conf = store.createConfirmation(
        {
          indicator_id: INDICATOR_ID,
          confirmation_type: '수정 후 확정',
          confirmer_name: '평가자B',
          edited_text: '실현된 수정본 제안입니다.',
          reason: '실사 결과 목표 달성 확인',
          edited_verdict_status: '실현',
        },
        db
      );

      expect(conf.confirmation_type).toBe('수정 후 확정');
      expect(conf.edited_verdict_status).toBe('실현');
      expect(conf.edited_text).toBe('실현된 수정본 제안입니다.');
      expect(conf.reason).toBe('실사 결과 목표 달성 확인');

      // 조회 검증
      const history = store.listConfirmations(INDICATOR_ID, db);
      expect(history.length).toBe(1);
      expect(history[0].edited_verdict_status).toBe('실현');
      expect(history[0].ai_verdict_status).toBe('추진 중');
    });

    it("유효하지 않은 판정 상태를 edited_verdict_status 로 전달하면 거부된다 (#23 결정)", () => {
      store.saveSuggestion(
        {
          id: 'sugg-invalid-verdict',
          indicator_id: INDICATOR_ID,
          verdict_status: '기대',
          error_reason: null,
          proposal_text: '기대 제안',
          created_at: new Date().toISOString(),
        },
        [],
        db
      );

      expect(() => {
        store.createConfirmation(
          {
            indicator_id: INDICATOR_ID,
            confirmation_type: '수정 후 확정',
            confirmer_name: '평가자C',
            edited_text: '수정본',
            reason: '사유',
            edited_verdict_status: '잘못된판정' as any,
          },
          db
        );
      }).toThrow('허용되지 않은 판정 상태입니다');
    });

    it("수정 후 확정에서 판정을 바꾸지 않고 연결 제안 판정과 같은 값을 넘기면 edited_verdict_status 가 NULL 로 정규화된다 (#23 검수)", () => {
      const normIndId = 'ind-norm-test';
      store.createIndicator(
        {
          id: normIndId,
          project_id: PROJECT_ID,
          level: '활동',
          name: '정규화 시험 지표',
          ovi: 'OVI',
          mov: null,
          target_value: '500명',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );

      // AI 제안: '추진 중'
      store.saveSuggestion(
        {
          id: 'sugg-norm-test',
          indicator_id: normIndId,
          verdict_status: '추진 중',
          error_reason: null,
          proposal_text: '추진 중 제안입니다.',
          created_at: new Date().toISOString(),
        },
        [],
        db
      );

      // 수정 후 확정: 판정을 변경하지 않고 제안과 동일한 '추진 중' 전달
      const conf = store.createConfirmation(
        {
          indicator_id: normIndId,
          confirmation_type: '수정 후 확정',
          confirmer_name: '평가자',
          edited_text: '수정본 제안입니다.',
          reason: '내용만 보완',
          edited_verdict_status: '추진 중',
        },
        db
      );

      // 반환된 객체에서 null 정규화 단언
      expect(conf.edited_verdict_status).toBeNull();

      // DB 이력 조회 시에도 NULL 정규화 단언
      const history = store.listConfirmations(normIndId, db);
      expect(history.length).toBe(1);
      expect(history[0].edited_verdict_status).toBeNull();
      expect(history[0].ai_verdict_status).toBe('추진 중');
    });
  });
});


