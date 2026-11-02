export const overviewFields: Array<{ title: string; aliases: string[][]; alwaysCheck?: boolean }> = [
    { title: '사업명', aliases: [['사업명', '사업 이름']] },
    { title: '협력국·협력부처', aliases: [['협력국', '대상국가'], ['협력부처', '협력 부처'], ['협력국·협력부처']] },
    { title: '사업 연차', aliases: [['사업 연차', '사업연차']] },
    { title: '사업분야', aliases: [['사업분야', '사업 분야']] },
    { title: '수행체계', aliases: [['수행체계', '수행 체계']] },
    { title: '사업예산', aliases: [['사업예산', '사업 예산']], alwaysCheck: true },
    { title: '세부주제', aliases: [['세부주제', '세부 주제']] },
    { title: '주요 활동', aliases: [['주요 활동', '주요활동']] },
];
