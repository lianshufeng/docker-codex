export type AsyncQuestion = { id: string; itemId: string; index: number; title: string; options: string[] };
export function questionKey(itemId: string, index: number): string;
export function parseQuestionReply(text: string): { questionItemId: string; question: string; answer: string }[] | null;
export function pendingQuestions(items: any[]): AsyncQuestion[];
export function questionReply(question: AsyncQuestion, answer: string): string;
export function normalizeAnswers(questions: any[], answers: unknown): Record<string, { answers: string[] }>;
