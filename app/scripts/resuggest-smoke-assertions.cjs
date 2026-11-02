function hasProposalContent(value) {
  return String(value).replace(/[“”"']/g, '').trim().length > 0;
}

function safeDiagnosticSummary(value) {
  const text = String(value);
  let category = 'details suppressed';
  if (text.includes('AI 응답 JSON 파싱 실패')) category = 'AI JSON parse failed';
  else if (text.includes('AI 응답 스키마 검증 실패')) category = 'AI schema validation failed';
  else if (text.includes('AI 응답에 본문 내용이 없습니다')) category = 'AI response had no content';
  else if (text.includes('empty proposal')) category = 'updated proposal was empty';
  else if (text.includes('no updated suggestion timestamp')) category = 'suggestion timestamp did not change';
  else if (/timeout|timed out|시간 초과|타임아웃/i.test(text)) category = 'operation timed out';
  else if (text.includes('AI 호출 실패')) category = 'AI request failed';
  else if (text.includes('근거 수치 검증')) category = 'proposal failed numeric evidence validation';
  else if (text.includes('인용 금지 검증')) category = 'proposal failed restricted quotation validation';
  else if (text.includes('근거 검증을 통과하지 못했습니다')) category = 'proposal failed evidence validation';
  else {
    const safeCategories = [
      'AI JSON parse failed',
      'AI schema validation failed',
      'AI response had no content',
      'updated proposal was empty',
      'suggestion timestamp did not change',
      'operation timed out',
      'AI request failed',
      'proposal failed numeric evidence validation',
      'proposal failed restricted quotation validation',
      'proposal failed evidence validation',
    ];
    category = safeCategories.find((safeCategory) => text.includes(safeCategory)) ?? category;
  }

  return category;
}

module.exports = { hasProposalContent, safeDiagnosticSummary };
