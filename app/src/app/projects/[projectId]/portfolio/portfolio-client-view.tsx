'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import React, { useState } from 'react';
import { ProjectTabs } from '../project-tabs';
import { savePortfolioLevelAction } from './actions';
import { axisLabel, exclusionReasonLabel } from '@/app/portfolio/axis-label';
import {
  COOPERATION_LEVELS,
  KNOWLEDGE_LEVELS,
  levelsForOutcomeFamily,
  outcomeBelongsToAxis,
  portfolioExclusionReason,
  type PortfolioOutcome,
  type PortfolioPageData,
} from '@/lib/portfolio';

function outcomeTypeLabel(outcome: PortfolioOutcome) {
  return outcome.type === 'outcome-short' ? '단기성과' : '중·장기성과';
}

function optionsFor(outcome: PortfolioOutcome) {
  const familyOptions = levelsForOutcomeFamily(outcome.outcomeFamily);
  return familyOptions.length ? familyOptions : [];
}

function AxisExclusions({ outcomes, axis }: { outcomes: PortfolioOutcome[]; axis: 'knowledge' | 'cooperation' }) {
  const exclusions = outcomes.flatMap((outcome) => {
    const reason = outcomeBelongsToAxis(outcome, axis) ? portfolioExclusionReason(outcome) : null;
    return reason ? [{ id: outcome.id, title: outcome.title, reason }] : [];
  });
  return exclusions.length ? <div className="mt-2 text-xs text-gray-600">
    <div>계산에서 빠진 성과</div>
    <ul className="mt-1 list-disc pl-4">{exclusions.map(({ id, title, reason }) =>
      <li key={id}>{title}: {exclusionReasonLabel(reason)}</li>)}</ul>
  </div> : null;
}

export function PortfolioClientView({ initialData, canEdit }: { initialData: PortfolioPageData; canEdit: boolean }) {
  const router = useRouter();
  const [selectedLevels, setSelectedLevels] = useState<Record<string, string>>({});
  const [pendingOutcomeKey, setPendingOutcomeKey] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const outcomeKey = (outcome: PortfolioOutcome) => JSON.stringify([initialData.projectId, initialData.importId, outcome.id]);
  const selectedLevel = (outcome: PortfolioOutcome) =>
    Object.hasOwn(selectedLevels, outcomeKey(outcome))
      ? selectedLevels[outcomeKey(outcome)]
      : outcome.teamLevel ?? '';

  const save = async (outcome: PortfolioOutcome) => {
    if (!initialData.importId) return;
    const key = outcomeKey(outcome);
    setPendingOutcomeKey(key);
    setMessage('');
    const result = await savePortfolioLevelAction(
      initialData.projectId,
      initialData.importId,
      outcome.id,
      selectedLevel(outcome),
    );
    setPendingOutcomeKey(null);
    if (result.success) {
      setMessage(`${outcome.title}: 평가팀 레벨을 이력에 추가했습니다.`);
      router.refresh();
    } else {
      setMessage(result.error);
    }
  };

  return <main className="min-h-screen bg-gray-50 px-4 py-6 sm:px-6 lg:px-8">
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="border-b border-gray-200 pb-4">
        <Link href="/projects" className="text-xs font-semibold text-blue-600 hover:text-blue-800">&larr; 사업 목록</Link>
        <h1 className="mt-2 text-2xl font-bold text-gray-900">⑨ 성과 수준 평가·사업 단위 종합·포트폴리오</h1>
        <p className="mt-1 text-sm text-gray-600">{initialData.projectName} · 단기·중장기 성과의 검토 상태와 평가팀 레벨을 확인합니다.</p>
        <ProjectTabs projectId={initialData.projectId} activeScreen="portfolio" />
      </header>

      <section aria-labelledby="portfolio-basis" className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
        <h2 id="portfolio-basis" className="font-semibold">기준: 볼트 R05(평가팀 확인 전 제안값)</h2>
        <p className="mt-1">K4 이상과 Lv3 이상을 각 축의 높은 값으로 봅니다. AI 레벨은 제안으로 표시하며 사업 단위 계산에는 평가팀 레벨만 사용합니다.</p>
      </section>

      <section aria-labelledby="project-summary-title" className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 id="project-summary-title" className="text-lg font-bold text-gray-900">현재 사업의 축 최댓값과 사분면</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg bg-gray-50 p-3"><div className="text-xs text-gray-500">지식활용 축</div><div className="mt-1 font-semibold">{axisLabel(initialData.summary.knowledge)}</div><AxisExclusions outcomes={initialData.outcomes} axis="knowledge" /></div>
          <div className="rounded-lg bg-gray-50 p-3"><div className="text-xs text-gray-500">협력확장 축</div><div className="mt-1 font-semibold">{axisLabel(initialData.summary.cooperation)}</div><AxisExclusions outcomes={initialData.outcomes} axis="cooperation" /></div>
          <div className="rounded-lg bg-blue-50 p-3"><div className="text-xs text-blue-700">사분면</div><div className="mt-1 font-bold text-blue-950">{initialData.summary.quadrant ?? '확인 필요: 한 축의 값이 비어 있음'}</div></div>
        </div>
      </section>

      <section aria-labelledby="portfolio-outcomes-title" className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="portfolio-outcomes-title" className="text-lg font-bold text-gray-900">사업별 성과 레벨</h2>
            <p className="mt-1 text-sm text-gray-600">정책 반영 성과에는 K0–K6, 나머지 세 성과군에는 Lv1–Lv5를 선택합니다.</p>
          </div>
          <span className="text-xs text-gray-500">수정 저장은 새 레벨 검토 이력을 추가합니다.</span>
        </div>
        {message && <p role="status" className="mt-3 rounded bg-blue-50 px-3 py-2 text-sm text-blue-900">{message}</p>}
        <div className="mt-4 overflow-x-auto">
          <table aria-label="사업별 성과 레벨 및 검토 상태" className="min-w-[1050px] w-full border-collapse text-left text-sm">
            <thead><tr className="border-b border-gray-200 bg-gray-50 text-xs text-gray-600">
              <th scope="col" className="px-3 py-2">성과 노트</th>
              <th scope="col" className="px-3 py-2">성과군</th>
              <th scope="col" className="px-3 py-2">AI 제안 레벨</th>
              <th scope="col" className="px-3 py-2">검토 상태</th>
              <th scope="col" className="px-3 py-2">평가팀 판정 레벨</th>
              <th scope="col" className="px-3 py-2">이력</th>
            </tr></thead>
            <tbody>
              {initialData.outcomes.length ? initialData.outcomes.map((outcome) => {
                const options = optionsFor(outcome);
                const value = selectedLevel(outcome);
                const changed = value !== (outcome.teamLevel ?? '')
                  || (outcome.teamLevelSource === 'imported' && outcome.history.length === 0);
                const key = outcomeKey(outcome);
                const exclusionReason = portfolioExclusionReason(outcome);
                return <tr key={outcome.id} className="border-b border-gray-100 align-top last:border-0">
                  <td className="px-3 py-3">
                    <div className="font-semibold text-gray-900">{outcome.title}</div>
                    <div className="mt-1 max-w-xl whitespace-pre-wrap text-xs text-gray-600">{outcome.text}</div>
                    <div className="mt-1 text-xs text-gray-500">{outcomeTypeLabel(outcome)}{outcome.outcomeState ? ` · 상태 ${outcome.outcomeState}` : ''}</div>
                    {exclusionReason && <div className="mt-1 text-xs text-amber-800">계산 제외: {exclusionReasonLabel(exclusionReason)}</div>}
                  </td>
                  <td className="px-3 py-3">{outcome.outcomeFamily || <span className="text-gray-500">미분류</span>}</td>
                  <td className="px-3 py-3">{outcome.aiLevel || <span className="text-gray-500">제안 없음</span>}</td>
                  <td className="px-3 py-3"><span className="rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700">{outcome.reviewStatus}</span></td>
                  <td className="px-3 py-3">
                    {options.length ? canEdit ? <div className="flex items-center gap-2">
                      <label className="sr-only" htmlFor={`portfolio-level-${outcome.id}`}>{outcome.title} 평가팀 레벨</label>
                      <select
                        id={`portfolio-level-${outcome.id}`}
                        value={value}
                        onChange={(event) => setSelectedLevels((current) => ({ ...current, [key]: event.target.value }))}
                        className="rounded border border-gray-300 bg-white px-2 py-1.5"
                      >
                        <option value="">미입력</option>
                        {(outcome.outcomeFamily === '협력국 정책 반영' ? KNOWLEDGE_LEVELS : COOPERATION_LEVELS).map((level) => <option key={level} value={level}>{level}</option>)}
                      </select>
                      <button
                        type="button"
                        onClick={() => void save(outcome)}
                        disabled={!changed || pendingOutcomeKey !== null || !initialData.importId}
                        className="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                      >{pendingOutcomeKey === key ? '저장 중...' : outcome.teamLevelSource === 'imported' && outcome.history.length === 0 ? '이력에 확인 저장' : '수정 저장'}</button>
                    </div> : <span>{outcome.teamLevel ?? '미입력'}</span> : <span className="text-gray-500">성과군 확인 필요</span>}
                    {outcome.teamLevelSource === 'imported' && <div className="mt-1 text-xs text-gray-500">가져온 평가팀 값 · 별도 레벨 이력 없음</div>}
                  </td>
                  <td className="px-3 py-3">
                    {outcome.history.length ? <details>
                      <summary className="cursor-pointer text-blue-700">레벨 이력 {outcome.history.length}건</summary>
                      <ol className="mt-2 space-y-2 text-xs text-gray-600">
                        {outcome.history.slice().reverse().map((entry) => <li key={entry.id} className="border-l-2 border-gray-200 pl-2">
                          <div>{entry.teamLevel ?? '미입력'} · {entry.outcomeFamily}</div>
                          <div>{entry.reviewer} · {entry.createdAt}</div>
                        </li>)}
                      </ol>
                    </details> : <span className="text-gray-500">이력 없음</span>}
                  </td>
                </tr>;
              }) : <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-gray-500">현재 성과 노트가 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <p><Link href="/portfolio" className="text-sm font-semibold text-blue-700 hover:underline">전체 사업 포트폴리오 보기 →</Link></p>
    </div>
  </main>;
}
