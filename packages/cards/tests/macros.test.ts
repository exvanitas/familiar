// Macros, with an injected clock and format.
import { describe, expect, it } from 'vitest';
import { fillMacros, UTC_FORMAT, type DateFormat } from '../src/index.ts';

const NOW = Date.UTC(2026, 10, 16, 14, 5);
const ctx = { char: 'Mira', user: 'Sam', now: NOW, format: UTC_FORMAT };

describe('macros', () => {
  it('fills char, user, time and date, in any case and with spaces inside the braces', () => {
    expect(fillMacros('{{char}} {{USER}} {{ Time }} {{date}}', ctx)).toBe('Mira Sam 14:05 2026-11-16');
  });

  it('fills the legacy <BOT> and <USER>, in any case', () => {
    expect(fillMacros('<BOT> greets <USER>; <bot>, <user>.', ctx)).toBe('Mira greets Sam; Mira, Sam.');
  });

  it('leaves unknown macros as written', () => {
    expect(fillMacros('{{random:a,b}} {{original}} {{charx}} <B0T>', ctx)).toBe('{{random:a,b}} {{original}} {{charx}} <B0T>');
  });

  it('is one pass: a name holding a macro is never expanded again', () => {
    expect(fillMacros('{{char}} meets {{user}}', { ...ctx, char: '{{user}}', user: '<BOT>' })).toBe('{{user}} meets <BOT>');
  });

  it('time and date come from the injected clock and format, never the wall clock', () => {
    const format: DateFormat = { time: (ms) => `t${ms}`, date: (ms) => `d${ms}` };
    expect(fillMacros('{{time}}/{{date}}', { ...ctx, now: 42, format })).toBe('t42/d42');
  });

  it('without a clock, time and date stay as written', () => {
    expect(fillMacros('{{char}} at {{time}} on {{date}}', { char: 'Mira', user: 'Sam' })).toBe('Mira at {{time}} on {{date}}');
  });

  it('the UTC format pads', () => {
    const t = Date.UTC(2027, 0, 2, 3, 4);
    expect([UTC_FORMAT.time(t), UTC_FORMAT.date(t)]).toEqual(['03:04', '2027-01-02']);
  });
});
