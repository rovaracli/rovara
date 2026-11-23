import { describe, it, expect, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { ReadSurface } from '../../../../packages/ui/src/screens/company-money-ai-read/ReadState.js';
import { readTime, durationHm, dollarsShort, modelName } from '../../../../packages/ui/src/screens/company-money-ai-read/Parts.js';
const ORIGINAL_TZ = process.env['TZ'];
afterEach(() => { if (ORIGINAL_TZ === undefined) delete process.env['TZ']; else process.env['TZ'] = ORIGINAL_TZ; });
describe('served times follow the viewer, never a fixed zone', () => {
 const served = '2026-11-21T15:20:00Z';
 it.each([['America/New_York', '10:20'], ['Asia/Kolkata', '20:50'], ['Pacific/Auckland', '04:20']])('formats the same instant for a viewer in %s', (zone, expected) => {
  process.env['TZ'] = zone;
  // "now" on the same local day as the served time: only the time shows.
  const text = readTime(served, new Date(served));
  expect(text).toBe(expected);
  expect(text).not.toMatch(/[A-Z]{2,}|UTC|GMT/u);
 });
 it('names no zone and keeps the date for another day', () => {
  process.env['TZ'] = 'America/New_York';
  expect(readTime(served, new Date('2026-12-01T12:00:00Z'))).toBe('21 Nov, 10:20');
  expect(readTime('not a time')).toBe('not a time');
 });
});
describe('plain words for numbers and models', () => {
 it('durations are "2 h 05 min"', () => {
  expect(durationHm(7_500_000)).toBe('2\u00a0h\u00a005\u00a0min');
  expect(durationHm(2_100_000)).toBe('35\u00a0min');
  expect(durationHm(20_000)).toBe('under 1\u00a0min');
  expect(durationHm(60 * 60_000 * 50)).toBe('2\u00a0d\u00a02\u00a0h');
 });
 it('money is whole dollars when the cents are zero', () => {
  expect(dollarsShort(6100)).toBe('$61');
  expect(dollarsShort(6123, true)).toBe('$61.23 or more');
 });
 it('a model id reads as its name; an unknown id stays as served', () => {
  expect(modelName('claude-sonnet-4-5')).toBe('Claude Sonnet 4.5');
  expect(modelName('claude-opus-4-1')).toBe('Claude Opus 4.1');
  expect(modelName('claude-opus-4')).toBe('Claude Opus 4');
  expect(modelName('fixture-model')).toBe('fixture-model');
 });
});

describe('stale timestamps match the local read time', () => {
 it.each([['America/New_York', '10:20'], ['Asia/Kolkata', '20:50']])('keeps only HH:MM for a viewer in %s, even on a later date', (zone, expected) => {
  process.env['TZ'] = zone;
  const client = new QueryClient(), queryKey = ['stale-time'];
  const since = Date.parse('2026-11-21T15:20:59Z');
  client.setQueryData(queryKey, { fact: 'kept' }, { updatedAt: since });
  client.getQueryCache().find({ queryKey })?.setState({ status: 'error', error: new Error('network') });
  const observer = new QueryObserver(client, { queryKey, enabled: false });
  const markup = renderToStaticMarkup(h(ReadSurface, { reads: [observer.getCurrentResult()], children: 'Kept facts' }));
  expect(markup).toContain(`>Updated ${expected} · Reconnecting</p>`);
  expect(readTime(since, new Date(since))).toBe(expected);
  observer.destroy();
  client.clear();
 });
});
