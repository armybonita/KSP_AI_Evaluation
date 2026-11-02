import {
  Document,
  ExternalHyperlink,
  FootnoteReferenceRun,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { ReportDraftData, ReportSection } from './types';

function appendAiExclusions(children: (Paragraph | Table)[], draft: ReportDraftData): void {
  if (!draft.ai_exclusions?.length) return;
  children.push(new Paragraph({ text: '부록. AI 입력 제외', heading: HeadingLevel.HEADING_2 }));
  for (const item of draft.ai_exclusions) {
    children.push(new Paragraph({ text: `${item.subject}: ${item.reasons.join(', ')}`, bullet: { level: 0 } }));
  }
}

/**
 * S4 해당 근거 주소를 생성한다 (#22 검수 반영 1차, Item 2)
 * 절대 주소는 환경변수 AIEAS_PUBLIC_BASE_URL, 없으면 상대 경로 텍스트
 */
export function buildEvidenceUrl(
  projectId: string,
  indicatorId: string,
  evidenceId: string
): string {
  const baseUrl = process.env.AIEAS_PUBLIC_BASE_URL?.trim()?.replace(/\/+$/, '');
  const relativePath = `/projects/${projectId}/review?indicatorId=${indicatorId}#evidence-${evidenceId}`;
  return baseUrl ? `${baseUrl}${relativePath}` : relativePath;
}

/**
 * Word (.docx) 보고서 생성기 (RQ-22, FE-11)
 * 일곱 절을 포함하는 Word 문서를 생성하고 바이너리 Buffer 로 반환한다.
 */
export async function generateReportDocx(draft: ReportDraftData): Promise<Buffer> {
  if (draft.version && draft.template !== 'legacy7' && draft.report_sections) return generateTemplateDocx(draft);
  const children: (Paragraph | Table)[] = [];

  // 제목
  children.push(
    new Paragraph({
      text: `${draft.project_name} 종료평가보고서 (초안)`,
      heading: HeadingLevel.TITLE,
      spacing: { after: 200 },
    })
  );

  // 요약 헤더 문구 (SP S6)
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `확정 ${draft.confirmed_count}건으로 만들었습니다. 보완 필요·채택 제외·미확정은 넣지 않았습니다.`,
          color: '4B5563',
          italics: true,
        }),
      ],
      spacing: { after: 400 },
    })
  );

  // 1. 성과지표 달성표
  children.push(
    new Paragraph({
      text: '1. 성과지표 달성표',
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 100 },
    })
  );

  const achievementRows = draft.sections.achievement_table.rows;
  if (!achievementRows || achievementRows.length === 0) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: '확정한 판단이 없습니다.', color: '6B7280' })],
        spacing: { after: 200 },
      })
    );
  } else {
    // 표 헤더 행
    const headerRow = new TableRow({
      tableHeader: true,
      children: [
        new TableCell({
          width: { size: 3000, type: WidthType.DXA },
          children: [new Paragraph({ children: [new TextRun({ text: '지표명', bold: true })] })],
        }),
        new TableCell({
          width: { size: 2500, type: WidthType.DXA },
          children: [new Paragraph({ children: [new TextRun({ text: '목표치', bold: true })] })],
        }),
        new TableCell({
          width: { size: 2000, type: WidthType.DXA },
          children: [new Paragraph({ children: [new TextRun({ text: '판정 결과', bold: true })] })],
        }),
        new TableCell({
          width: { size: 2000, type: WidthType.DXA },
          children: [new Paragraph({ children: [new TextRun({ text: '근거 위치', bold: true })] })],
        }),
      ],
    });

    const dataRows = achievementRows.map(
      (row) =>
        new TableRow({
          children: [
            new TableCell({
              width: { size: 3000, type: WidthType.DXA },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({ text: row.indicator_name }),
                    ...(row.is_orphaned
                      ? [
                          new TextRun({
                            text: ' (문서에서 사라진 지표)',
                            color: '92400E',
                          }),
                        ]
                      : []),
                  ],
                }),
              ],
            }),
            new TableCell({
              width: { size: 2500, type: WidthType.DXA },
              children: [new Paragraph({ text: row.target_value })],
            }),
            new TableCell({
              width: { size: 2000, type: WidthType.DXA },
              children: [
                new Paragraph({ text: row.status_display }),
                ...(row.confirmation_type === '수정 후 확정' && row.edited_text
                  ? [
                      new Paragraph({
                        children: [
                          new TextRun({
                            text: `[수정본] ${row.edited_text}`,
                            size: 18,
                            color: '1D4ED8',
                          }),
                        ],
                        spacing: { before: 60 },
                      }),
                    ]
                  : []),
              ],
            }),
            new TableCell({
              width: { size: 2000, type: WidthType.DXA },
              children: [
                new Paragraph({
                  children: [
                    row.evidence_id
                      ? new ExternalHyperlink({
                          children: [
                            new TextRun({
                              text: row.evidence_location
                                ? `[근거: ${row.evidence_location}]`
                                : '[근거]',
                              color: '2563EB',
                              underline: {},
                            }),
                          ],
                          link: buildEvidenceUrl(
                            draft.project_id,
                            row.indicator_id,
                            row.evidence_id
                          ),
                        })
                      : new TextRun({
                          text: '-',
                          color: '9CA3AF',
                        }),
                  ],
                }),
              ],
            }),
          ],
        })
    );

    const table = new Table({
      width: { size: 9500, type: WidthType.DXA },
      rows: [headerRow, ...dataRows],
    });
    children.push(table);
    children.push(new Paragraph({ spacing: { after: 200 } }));
  }

  // 2. 성과 분석
  children.push(
    new Paragraph({
      text: '2. 성과 분석',
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 100 },
    })
  );

  const sentences = draft.sections.performance_analysis.sentences;
  if (!sentences || sentences.length === 0) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: '확정한 판단이 없습니다.', color: '6B7280' })],
        spacing: { after: 200 },
      })
    );
  } else {
    for (const sent of sentences) {
      const paragraphChildren: (TextRun | ExternalHyperlink)[] = [
        new TextRun({ text: sent.sentence }),
      ];

      // #22 Item 2 & 3: [근거]는 하이퍼링크이며, 검증 통과한 모든 근거 id 표시
      const evidencesToDisplay =
        sent.evidences && sent.evidences.length > 0
          ? sent.evidences
          : sent.evidence_ids && sent.evidence_ids.length > 0
          ? sent.evidence_ids.map((id) => ({
              id,
              location: sent.evidence_location,
              document_name: sent.document_name,
            }))
          : sent.evidence_id
          ? [
              {
                id: sent.evidence_id,
                location: sent.evidence_location,
                document_name: sent.document_name,
              },
            ]
          : [];

      for (let i = 0; i < evidencesToDisplay.length; i++) {
        const ev = evidencesToDisplay[i];
        const citeText = ev.location
          ? `[근거: ${ev.document_name ?? ''} ${ev.location}]`
          : evidencesToDisplay.length > 1
          ? `[근거 ${i + 1}]`
          : '[근거]';

        paragraphChildren.push(new TextRun({ text: ' ' }));
        paragraphChildren.push(
          new ExternalHyperlink({
            children: [
              new TextRun({
                text: citeText,
                color: '2563EB',
                bold: true,
                underline: {},
              }),
            ],
            link: buildEvidenceUrl(draft.project_id, sent.indicator_id, ev.id),
          })
        );
      }

      children.push(
        new Paragraph({
          children: paragraphChildren,
          spacing: { after: 100 },
        })
      );
    }
    children.push(new Paragraph({ spacing: { after: 200 } }));
  }

  // 3. 기여요인
  children.push(
    new Paragraph({
      text: '3. 기여요인',
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 100 },
    })
  );

  if (draft.sections.contributing_factors.excluded_notice) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: draft.sections.contributing_factors.excluded_notice,
            color: '92400E',
            italics: true,
            size: 18,
          }),
        ],
        spacing: { after: 100 },
      })
    );
  }

  const contributingSentences = draft.sections.contributing_factors.sentences;
  if (contributingSentences && contributingSentences.length > 0) {
    for (const sent of contributingSentences) {
      const paragraphChildren: (TextRun | ExternalHyperlink)[] = [
        new TextRun({ text: sent.sentence }),
      ];

      const evidencesToDisplay =
        sent.evidences && sent.evidences.length > 0
          ? sent.evidences
          : sent.evidence_ids && sent.evidence_ids.length > 0
          ? sent.evidence_ids.map((id) => ({
              id,
              location: sent.evidence_location,
              document_name: sent.document_name,
            }))
          : sent.evidence_id
          ? [
              {
                id: sent.evidence_id,
                location: sent.evidence_location,
                document_name: sent.document_name,
              },
            ]
          : [];

      for (let i = 0; i < evidencesToDisplay.length; i++) {
        const ev = evidencesToDisplay[i];
        const citeText = ev.location
          ? `[근거: ${ev.document_name ?? ''} ${ev.location}]`
          : evidencesToDisplay.length > 1
          ? `[근거 ${i + 1}]`
          : '[근거]';

        paragraphChildren.push(new TextRun({ text: ' ' }));
        paragraphChildren.push(
          new ExternalHyperlink({
            children: [
              new TextRun({
                text: citeText,
                color: '2563EB',
                bold: true,
                underline: {},
              }),
            ],
            link: buildEvidenceUrl(draft.project_id, sent.indicator_id, ev.id),
          })
        );
      }

      children.push(
        new Paragraph({
          children: paragraphChildren,
          spacing: { after: 100 },
        })
      );
    }
    children.push(new Paragraph({ spacing: { after: 200 } }));
  } else {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: draft.sections.contributing_factors.content || '확정한 판단이 없습니다.',
            color: draft.sections.contributing_factors.content ? '111827' : '6B7280',
          }),
        ],
        spacing: { after: 200 },
      })
    );
  }

  // 4. 제약요인과 대응
  children.push(
    new Paragraph({
      text: '4. 제약요인과 대응',
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: draft.sections.constraints_and_responses.content || '확정한 판단이 없습니다.',
          color: draft.sections.constraints_and_responses.content ? '111827' : '6B7280',
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 5. 교훈
  children.push(
    new Paragraph({
      text: '5. 교훈',
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: draft.sections.lessons_learned.content || '확정한 판단이 없습니다.',
          color: draft.sections.lessons_learned.content ? '111827' : '6B7280',
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 6. 모니터링 계획
  children.push(
    new Paragraph({
      text: '6. 모니터링 계획',
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: draft.sections.monitoring_plan.content || '확정한 판단이 없습니다.',
          color: draft.sections.monitoring_plan.content ? '111827' : '6B7280',
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 7. 종합평가
  children.push(
    new Paragraph({
      text: '7. 종합평가',
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: draft.sections.overall_evaluation.content || '확정한 판단이 없습니다.',
          color: draft.sections.overall_evaluation.content ? '111827' : '6B7280',
        }),
      ],
      spacing: { after: 200 },
    })
  );

  appendAiExclusions(children, draft);
  const doc = new Document({
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  return await Packer.toBuffer(doc);
}

async function generateTemplateDocx(draft: ReportDraftData): Promise<Buffer> {
  const notes = draft.footnotes ?? [];
  const labels = { human: '사람 확정', ai: 'AI 제안', document: '문서 원문', missing: '근거 미확보' } as const;
  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: `${draft.project_name} 종료평가보고서 (초안 v${draft.draft_number ?? 1})`, heading: HeadingLevel.TITLE }),
    new Paragraph('④~⑦에서 확정한 성과·근거로 만든 초안입니다. 미확인 사항은 한계로 적습니다.'),
    new Paragraph(`서식: ${draft.template_source ?? `${draft.template?.toUpperCase()} 종료평가보고서`}`),
    new Paragraph('각 문장 끝의 [n]은 근거 스니펫, 링크된 노드는 판단의 단위다. 레벨·신뢰도는 AI 제안이며 PO가 확정한다.'),
  ];
  const refs = (ids: string[], indicatorId: string) => ids.flatMap(id => {
    const note = notes.find(item => item.evidence_id === id);
    return note ? [new ExternalHyperlink({ children: [new TextRun({ text: `[${note.number}]`, color: '2563EB', underline: {} })], link: buildEvidenceUrl(draft.project_id, indicatorId, id) }), new FootnoteReferenceRun(note.number)] : [];
  });
  const visit = (section: ReportSection) => {
    const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
    children.push(new Paragraph({ text: `${section.title}${section.source ? ` [${labels[section.source]}]` : ''}`, heading: levels[Math.min(6, Math.max(1, section.level)) - 1] }));
    if (section.table) {
      const cell = (paragraph: Paragraph) => new TableCell({ children: [paragraph] });
      const header = new TableRow({ tableHeader: true, children: section.table.columns.map(text => cell(new Paragraph({ children: [new TextRun({ text, bold: true })] }))) });
      const rows = section.table.rows.map(row => new TableRow({ children: row.map(item => {
        // Keep the established Word label for evaluator-edited finalized text.
        const text = item.text.replace(/\[사람 확정 수정본\]/g, '[수정본]');
        return cell(new Paragraph({ children: [...(item.is_label ? [] : [new TextRun(`[${labels[item.source]}] `)]), new TextRun(text), ...refs(item.evidence_ids ?? [], item.indicator_id ?? '')] }));
      }) }));
      children.push(new Table({ rows: [header, ...rows], width: { size: 9500, type: WidthType.DXA } }));
    }
    if (section.rows?.length) {
      const cell = (children: Paragraph[]) => new TableCell({ children });
      const header = new TableRow({ tableHeader: true, children: ['지표명', '목표치', '판정 결과', '근거'].map(text => cell([new Paragraph({ children: [new TextRun({ text, bold: true })] })])) });
      const rows = section.rows.map(row => {
        const edited = row.confirmation_type === '수정 후 확정' && row.edited_text ? ` [수정본] ${row.edited_text}` : '';
        const orphan = row.is_orphaned ? ' (문서에서 사라진 지표)' : '';
        const evidenceCell = [
          new Paragraph({ children: row.evidence_id ? refs([row.evidence_id], row.indicator_id) : [new TextRun('근거 미확인')] }),
          ...(row.evidence_match_warning ? [new Paragraph({ children: [new TextRun({ text: row.evidence_match_warning, color: 'B45309' })] })] : []),
        ];
        return new TableRow({ children: [cell([new Paragraph(row.indicator_name + orphan)]), cell([new Paragraph(row.target_value)]), cell([new Paragraph(`[${labels[row.source ?? 'ai']}] ${row.status_display + edited}`)]), cell(evidenceCell)] });
      });
      children.push(new Table({ rows: [header, ...rows], width: { size: 9500, type: WidthType.DXA } }));
    }
    for (const sentence of section.sentences ?? []) children.push(new Paragraph({ children: [new TextRun(`[${labels[sentence.source ?? 'human']}] ${sentence.node_label ? `${sentence.node_label} ` : ''}${sentence.sentence}`), ...refs(sentence.evidence_ids?.length ? sentence.evidence_ids : sentence.evidence_id ? [sentence.evidence_id] : [], sentence.indicator_id), ...(sentence.evidence_match_warning ? [new TextRun({ text: ` ${sentence.evidence_match_warning}`, color: 'B45309' })] : [])] }));
    if (section.content || section.empty_message) children.push(new Paragraph(section.content || `[근거 미확보] ${section.empty_message}`));
    section.children?.forEach(visit);
  };
  draft.report_sections?.forEach(visit);
  appendAiExclusions(children, draft);
  const footnotes = Object.fromEntries(notes.map(note => [String(note.number), { children: [new Paragraph(`[${note.number}] ${note.document_name || '문서명 미확인'} · ${note.location || '위치 미확인'} · ${note.quote || ''}`)] }]));
  return Packer.toBuffer(new Document({ footnotes, sections: [{ children }] }));
}
