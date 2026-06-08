import { BadRequestException } from '@nestjs/common';
import { parseExamDocx } from './docx-parser';

describe('parseExamDocx', () => {
  it('parses the 2-variant jismoniy tarbiya sample into tickets of verbal questions', () => {
    const raw = [
      '1-variant',
      'Jismoniy tarbiya darslarining asosiy vazifalari nimalardan iborat?',
      'Maktabgacha ta’lim tashkilotlarida jismoniy tarbiyaning maqsadi nima?',
      'Umumta’lim maktablarida jismoniy tarbiya darslarining ahamiyati.',
      'Pedagogik tahlil tushunchasi va uning vazifalari.',
      '“Alpomish” va “Barchinoy” testlarining maqsadi.',
      '2-variant',
      'Jismoniy tarbiya darslarining sog‘lomlashtirish vazifalari.',
      'MTTda jismoniy mashg‘ulotlarni tashkil etish shakllari.',
      'Umumta’lim maktablarida jismoniy tarbiya mazmuni.',
      'Xronometraj usulining mohiyati.',
      'Sinfdan tashqari jismoniy tarbiya ishlarining turlari.',
    ].join('\n');

    const result = parseExamDocx(raw);

    expect(result.tickets).toHaveLength(2);
    expect(result.tickets[0].questions).toHaveLength(5);
    expect(result.tickets[1].questions).toHaveLength(5);

    const first = result.tickets[0].questions[0];
    expect(first.type).toBe('verbal');
    expect(first.text).toBe(
      'Jismoniy tarbiya darslarining asosiy vazifalari nimalardan iborat?',
    );
    expect(first.points).toBeGreaterThan(0);
    expect(first.time).toBeGreaterThan(0);
    expect(first.difficulty).toBe('medium');
    expect(first.rubric).toBe('');

    // last question of the second ticket
    expect(result.tickets[1].questions[4].text).toBe(
      'Sinfdan tashqari jismoniy tarbiya ishlarining turlari.',
    );
  });

  it('strips leading bullet glyphs and numbering from question lines', () => {
    const raw = [
      '1-variant',
      '•\tFirst question?',
      '2) Second question?',
      '2-variant',
      '• Third question?',
    ].join('\n');

    const result = parseExamDocx(raw);
    expect(result.tickets).toHaveLength(2);
    expect(result.tickets[0].questions.map((q) => q.text)).toEqual([
      'First question?',
      'Second question?',
    ]);
    expect(result.tickets[1].questions[0].text).toBe('Third question?');
  });

  it('recognizes several variant header spellings', () => {
    const raw = [
      'Variant 1',
      'Q1',
      'вариант 2',
      'Q2',
      '3-bilet',
      'Q3',
    ].join('\n');

    const result = parseExamDocx(raw);
    expect(result.tickets).toHaveLength(3);
    expect(result.tickets.every((t) => t.questions.length === 1)).toBe(true);
  });

  it('captures a heading before the first variant as the exam title', () => {
    const raw = ['Jismoniy tarbiya — yakuniy imtihon', '1-variant', 'Q1'].join('\n');
    const result = parseExamDocx(raw);
    expect(result.title).toBe('Jismoniy tarbiya — yakuniy imtihon');
    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0].questions).toHaveLength(1);
  });

  it('falls back to a single ticket when there are no variant headers', () => {
    const raw = ['• Only question one', '• Only question two'].join('\n');
    const result = parseExamDocx(raw);
    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0].questions).toHaveLength(2);
  });

  it('throws on an empty document', () => {
    expect(() => parseExamDocx('   \n\n  ')).toThrow(BadRequestException);
  });
});
